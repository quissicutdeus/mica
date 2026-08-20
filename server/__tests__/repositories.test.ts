import { describe, it, expect, vi } from 'vitest';

const { dbMock } = vi.hoisted(() => ({
  dbMock: {
    query: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    scalar: vi.fn(),
    single: vi.fn()
  }
}));

vi.mock('../lib/Database', () => ({ Database: dbMock }));

import { Repository } from '../lib/Repository';
import { contacts } from '../services/Contacts';
import { mail } from '../services/Mail';
import { conversations } from '../services/Conversations';
import { messages } from '../services/Messages';
// Notes has migrated to a defineService declaration; its repository is derived.
import { notes } from '../services/Notes';
import { media } from '../services/Media';
import { reports } from '../services/Reports';
import { batteryApp } from '../services/Battery';
import { hodlr } from '../services/Hodlr';

/**
 * The shipped write policy, table by table.
 *
 * These are deliberately literal rather than derived: the point is that widening
 * what a client may write becomes a visible, intentional diff here, not a silent
 * consequence of editing a repository.
 */
const ALL = [
  { name: 'contacts', repo: contacts.repo },
  { name: 'conversations', repo: conversations.repo },
  { name: 'mail', repo: mail.repo },
  { name: 'messages', repo: messages.repo },
  { name: 'notes', repo: notes.repo },
  { name: 'media', repo: media.repo },
  // Both were missing, which is how a dead-code scan came to report `reports` as an
  // unused export: this file was the only thing that ever imported a declaration, so
  // one absent from it looked like one nobody used.
  { name: 'reports', repo: reports.repo },
  { name: 'battery', repo: batteryApp.repo },
  { name: 'hodlr', repo: hodlr.repo }
] satisfies { name: string; repo: Repository<any> }[];

describe('shipped repositories — declared client write policy', () => {
  it.each([
    ['contacts', ['firstname', 'lastname', 'phone', 'email', 'avatar', 'favorite']],
    ['conversations', ['name']],
    ['notes', ['title', 'content']],
    // `kind` and `data` only. The media table carries nine more columns, and every one is
    // `clientWritable: false` until a feature writes it — a column a client can set before
    // any caller needs it is unconstrained surface (§2.9).
    ['media', ['kind', 'data']],
    // Every mutation on these goes through a named, authorizing method.
    ['mail', []],
    ['messages', []],
    ['reports', []],
    ['battery', []],
    ['hodlr', []]
  ])('%s exposes exactly the expected writable columns', (name, expected) => {
    const entry = ALL.find((candidate) => candidate.name === name)!;
    expect(entry.repo.writableColumns).toEqual(expected);
  });

  it.each(ALL)('$name never lets a client write status', ({ repo }) => {
    // Soft-delete and moderation state is not the client's to set: allowing it
    // would turn `update` into an un-delete and a self-moderation bypass.
    expect(repo.writableColumns).not.toContain('status');
  });

  it.each(ALL)('$name never lets a client write identity or timestamps', ({ repo }) => {
    for (const forbidden of ['id', 'citizenid', 'created_at', 'updated_at']) {
      expect(repo.writableColumns).not.toContain(forbidden);
    }
  });

  it.each(ALL)('$name only declares columns that exist on the table', ({ repo }) => {
    for (const column of [...repo.writableColumns, ...repo.filterableColumns]) {
      expect(repo.tableColumns).toContain(column);
    }
  });

  it.each(ALL)(
    '$name declares a citizenid column so writes can be ownership-scoped',
    ({ repo }) => {
      expect(repo.tableColumns).toContain('citizenid');
    }
  );
});

describe('shipped repositories — inherited guarantees', () => {
  it('mail delete is inherited and ownership-scoped', async () => {
    // The pre-Phase-1 override silently fell back to an unscoped UPDATE when the
    // generic path called it with one argument. There is no override now at all.
    dbMock.update.mockResolvedValue(true);
    dbMock.update.mockClear();

    await expect(mail.repo.delete(4, '')).rejects.toThrow(/requires a citizenid/);
    expect(dbMock.update).not.toHaveBeenCalled();

    await mail.repo.delete(4, 'CIT_OWNER');
    expect(String(dbMock.update.mock.calls[0][0])).toContain('`citizenid` = ?');
    expect(dbMock.update.mock.calls[0][1]).toEqual(['deleted', 4, 'CIT_OWNER']);
  });

  it('conversation membership is a positive check, not an absence of error', async () => {
    dbMock.single.mockResolvedValueOnce({ 1: 1 });
    await expect(conversations.repo.isMember(3, 'CIT_A')).resolves.toBe(true);

    dbMock.single.mockResolvedValueOnce(null);
    await expect(conversations.repo.isMember(3, 'CIT_STRANGER')).resolves.toBe(false);
  });

  it('membership carries the liveness rule, so someone who left is not a member', async () => {
    // `left_at IS NULL` used to be re-typed into every participants query by hand, and an
    // omission is invisible: the check passes and a player who left the thread keeps acting
    // on it. It comes from the declaration now, so it cannot be forgotten at a call site.
    dbMock.single.mockClear();
    dbMock.single.mockResolvedValueOnce(null);

    await conversations.repo.isMember(3, 'CIT_A');

    const sql = String(dbMock.single.mock.calls[0][0]);
    expect(sql).toContain('`left_at` IS NULL');
    expect(sql).toContain('`gphone_messages_participants`');
    expect(dbMock.single.mock.calls[0][1]).toEqual([3, 'CIT_A']);
  });

  it('keys a message on its parent conversation, not on its own id', async () => {
    // The reason `localKey` exists. Messages and Conversations share one join table but
    // reach it from different columns; without the distinction, a message's membership
    // would be looked up by the message id and match nothing.
    expect(messages.resolved.membership?.localKey).toBe('conversation_id');
    expect(conversations.resolved.membership?.localKey).toBe('id');
  });

  it('refuses isMember on a table that never declared membership', async () => {
    // Better than silently answering false, which would read as "not a member" and deny
    // access for a reason that has nothing to do with the player.
    await expect(mail.repo.isMember(1, 'CIT_OWNER')).rejects.toThrow(/requires a 'membership'/);
  });

  it('markRead only moves the caller own read cursor, and only while still joined', async () => {
    dbMock.update.mockResolvedValue(true);
    dbMock.update.mockClear();

    await (conversations.repo as any).markRead(3, 'CIT_A');

    const sql = String(dbMock.update.mock.calls[0][0]).replace(/\s+/g, ' ').trim();
    expect(sql).toBe(
      'UPDATE gphone_messages_participants SET last_read = CURRENT_TIMESTAMP ' +
        'WHERE conversation_id = ? AND citizenid = ? AND left_at IS NULL'
    );
    expect(dbMock.update.mock.calls[0][1]).toEqual([3, 'CIT_A']);
  });

  it('findForCitizen computes unread_count from the caller own last_read', async () => {
    dbMock.query.mockResolvedValue([]);
    dbMock.query.mockClear();

    await (conversations.repo as any).findForCitizen('CIT_A');

    const sql = String(dbMock.query.mock.calls[0][0]).replace(/\s+/g, ' ');
    // Joins the caller's own participant row so last_read is in scope...
    expect(sql).toContain('JOIN gphone_messages_participants me');
    expect(sql).toContain('me.citizenid = ?');
    expect(sql).toContain('me.left_at IS NULL');
    // ...counts only messages newer than it, and never the caller's own.
    expect(sql).toContain('unread.created_at > me.last_read');
    expect(sql).toContain('unread.citizenid <> me.citizenid');
    expect(sql).toContain("unread.status != 'deleted'");
    expect(dbMock.query.mock.calls[0][1]).toEqual(['CIT_A']);
  });

  it('admin conversation deletion is a named privileged write, scoped to the row id', async () => {
    dbMock.update.mockResolvedValue(true);
    dbMock.update.mockClear();

    await (conversations.repo as any).markDeletedByAdmin(12);

    const sql = String(dbMock.update.mock.calls[0][0]).replace(/\s+/g, ' ');
    // No ownership predicate — the caller authorized via participant role — but
    // still confined to a single conversation id.
    expect(sql).toBe('UPDATE `gphone_messages_conversations` SET `status` = ? WHERE `id` = ?');
    expect(dbMock.update.mock.calls[0][1]).toEqual(['deleted', 12]);
  });
});
