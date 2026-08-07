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
      expect(joinSql).toContain('p.data');
    });

    it('never selects the uploader citizenid', async () => {
      // A conversation is shared, so anything this query selects reaches every
      // participant — and the uploader's citizenid is the one field that ties a picture
      // back to a person who only meant to send it. `SELECT p.*` would hand it over
      // silently, which is why the column list is explicit (§10, publicColumns).
      dbMock.query.mockResolvedValueOnce([{ id: 1, conversation_id: 4 }]);
      await (messages.repo as MessageRepository).findByConversation(4);

      const joinSql = dbMock.query.mock.calls[1][0] as string;
      expect(joinSql).not.toMatch(/p\.citizenid/);
      expect(joinSql).not.toMatch(/p\.\*/);
    });

    it('carries enough of the row to draw a video', async () => {
      // Selecting only `data`, as this did, made every attachment a photo by
      // construction: a video has no `data` at all and renders from its thumbnail.
      dbMock.query.mockResolvedValueOnce([{ id: 1, conversation_id: 4 }]);
      dbMock.query.mockResolvedValueOnce([
        {
          id: 9,
          message_id: 1,
          media_id: 3,
          kind: 'video',
          data: null,
          thumbnail: 'https://x.test/p.jpg',
          duration_ms: 12000
        }
      ]);
      const [message] = await (messages.repo as MessageRepository).findByConversation(4);

      expect(message.attachments?.[0].media).toMatchObject({
        id: 3,
        kind: 'video',
        thumbnail: 'https://x.test/p.jpg',
        duration_ms: 12000
      });
      expect(message.attachments?.[0].media).not.toHaveProperty('citizenid');
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
