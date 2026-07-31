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
import { contacts } from '../controllers/ContactController';
import { ConversationRepository } from '../repositories/ConversationRepository';
import { mail } from '../controllers/MailController';
import { MessageRepository } from '../repositories/MessageRepository';
// Notes has migrated to a defineServerApp declaration; its repository is derived.
import { notes } from '../controllers/NoteController';
import { photos } from '../controllers/PhotoController';

/**
 * The shipped write policy, table by table.
 *
 * These are deliberately literal rather than derived: the point is that widening
 * what a client may write becomes a visible, intentional diff here, not a silent
 * consequence of editing a repository.
 */
const ALL = [
  { name: 'contacts', repo: contacts.repo },
  { name: 'conversations', repo: new ConversationRepository() },
  { name: 'mail', repo: mail.repo },
  { name: 'messages', repo: new MessageRepository() },
  { name: 'notes', repo: notes.repo },
  { name: 'photos', repo: photos.repo }
] satisfies { name: string; repo: Repository<any> }[];

describe('shipped repositories — declared client write policy', () => {
  it.each([
    ['contacts', ['firstname', 'lastname', 'phone', 'email', 'avatar', 'favorite']],
    ['conversations', ['name']],
    ['notes', ['title', 'content']],
    ['photos', ['image']],
    // Every mutation on these goes through a named, authorizing method.
    ['mail', []],
    ['messages', []]
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
    const conversations = new ConversationRepository();

    dbMock.single.mockResolvedValueOnce({ 1: 1 });
    await expect(conversations.isParticipant(3, 'CIT_A')).resolves.toBe(true);

    dbMock.single.mockResolvedValueOnce(null);
    await expect(conversations.isParticipant(3, 'CIT_STRANGER')).resolves.toBe(false);
  });

  it('markRead only moves the caller own read cursor, and only while still joined', async () => {
    const conversations = new ConversationRepository();
    dbMock.update.mockResolvedValue(true);
    dbMock.update.mockClear();

    await conversations.markRead(3, 'CIT_A');

    const sql = String(dbMock.update.mock.calls[0][0]).replace(/\s+/g, ' ').trim();
    expect(sql).toBe(
      'UPDATE gphone_messages_participants SET last_read = CURRENT_TIMESTAMP ' +
        'WHERE conversation_id = ? AND citizenid = ? AND left_at IS NULL'
    );
    expect(dbMock.update.mock.calls[0][1]).toEqual([3, 'CIT_A']);
  });

  it('findForCitizen computes unread_count from the caller own last_read', async () => {
    const conversations = new ConversationRepository();
    dbMock.query.mockResolvedValue([]);
    dbMock.query.mockClear();

    await conversations.findForCitizen('CIT_A');

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
    const conversations = new ConversationRepository();
    dbMock.update.mockResolvedValue(true);
    dbMock.update.mockClear();

    await conversations.markDeletedByAdmin(12);

    const sql = String(dbMock.update.mock.calls[0][0]).replace(/\s+/g, ' ');
    // No ownership predicate — the caller authorized via participant role — but
    // still confined to a single conversation id.
    expect(sql).toBe('UPDATE `gphone_messages_conversations` SET `status` = ? WHERE `id` = ?');
    expect(dbMock.update.mock.calls[0][1]).toEqual(['deleted', 12]);
  });
});
