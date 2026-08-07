import { describe, it, expect, vi, beforeEach } from 'vitest';

const { dbMock } = vi.hoisted(() => ({
  dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() }
}));
vi.mock('../lib/Database', () => ({ Database: dbMock }));
vi.mock('../lib/FrameworkBridge', () => ({
  FrameworkBridge: {
    getPlayer: vi.fn(),
    getAllPlayers: vi.fn(() => ({})),
    registerUsableItem: vi.fn()
  }
}));

import { photos } from '../services/Photos';
import { messages } from '../services/Messages';
import type { MessageRepository } from '../repositories/MessageRepository';
import { REPORTABLE, isReportableTable } from '../lib/moderation';

/**
 * `gphone_photos` became `gphone_media`, and the parts of that rename no other check can see.
 *
 * The typechecker found every `.image` and every `Photo` import. It cannot see a table name
 * inside a SQL string, an allowlist key, or a `previewColumn` — which is precisely where a
 * half-finished rename survives and fails at runtime against a real database.
 */
beforeEach(() => {
  vi.clearAllMocks();
  dbMock.query.mockResolvedValue([]);
});

describe('the media table rename', () => {
  it('keeps the service and app id as photos while moving the table', () => {
    // The id is a key — the directory, the storage namespace, the event segment and the
    // `?app=photos` deep link all use it, so renaming it would be a data migration (§11.1).
    // The table name is a key to nothing outside SQL.
    expect(photos.resolved.id).toBe('photos');
    expect(photos.resolved.table).toBe('gphone_media');
  });

  it('carries every media kind, because widening the enum later costs a migration', () => {
    // `SchemaMigrator` is additive-only: a type change is printed for a human and never
    // applied (§8). Anything missing here is a second hand-written migration against a
    // bigger table.
    expect(photos.resolved.columnRules.kind.values).toEqual([
      'photo',
      'video',
      'audio',
      'gif',
      'sticker',
      'file',
      'link'
    ]);
  });

  it('still carries every column the table needs', () => {
    // `columnRules` is the identifier allowlist §2.9 checks every payload key against, so
    // a column missing here is a column the client can never write, however the DDL reads.
    expect(Object.keys(photos.resolved.columnRules)).toEqual(
      expect.arrayContaining(['kind', 'data', 'url', 'thumbnail', 'alt_text'])
    );
    // And the old name is gone rather than living alongside the new one.
    expect(photos.resolved.columnRules).not.toHaveProperty('image');
  });

  describe('the attachment join', () => {
    it('selects from gphone_media, not the old table', async () => {
      // This query is a string. Nothing typechecks it, and it is the one place a message
      // attachment's bytes come from — so a missed rename here is an SQL error in game and
      // green everywhere else.
      dbMock.query.mockResolvedValueOnce([{ id: 1, conversation_id: 4 }]);
      await (messages.repo as MessageRepository).findByConversation(4);

      const joinSql = dbMock.query.mock.calls[1][0] as string;
      expect(joinSql).toContain('JOIN gphone_media');
      expect(joinSql).not.toContain('gphone_photos');
      // The column moved too, and aliasing it keeps the wire shape identical.
      expect(joinSql).toContain('p.data as attachment');
    });
  });

  describe('the moderation allowlist', () => {
    it('accepts the new table and previews the renamed column', () => {
      expect(isReportableTable('gphone_media')).toBe(true);
      expect(REPORTABLE.gphone_media.previewColumn).toBe('data');
    });

    it('no longer accepts the old name', () => {
      // Not kept "for compatibility". `target_table` is interpolated into SQL because MySQL
      // cannot parameterise an identifier, so this list is a security boundary (§2.9) and a
      // stale entry is a second accepted name for one table. The migration rewrites the
      // historical rows instead.
      expect(isReportableTable('gphone_photos')).toBe(false);
    });
  });
});
