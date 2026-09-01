// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

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
// The three declarations that carry a `clientFilterable` column, and the reason the filter
// policy below has anything to assert. Absent from `ALL` until MICA-137, which is part of
// why the derivation that dropped their filter columns went unnoticed.
import { accounts } from '../services/Accounts';
import { blabber } from '../services/Blabber';
import { notifications } from '../services/Notifications';

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
  { name: 'hodlr', repo: hodlr.repo },
  { name: 'accounts', repo: accounts.repo },
  { name: 'blabber', repo: blabber.repo },
  { name: 'notifications', repo: notifications.repo }
] satisfies { name: string; repo: Repository<any> }[];

describe('shipped repositories — declared client write policy', () => {
  it.each([
    ['contacts', ['firstname', 'lastname', 'phone', 'email', 'avatar', 'ringtone', 'favorite']],
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

/**
 * The shipped **filter** policy, which is not the write policy and was derived from it until
 * MICA-137.
 *
 * Literal, for the same reason the write lists above are: every filterable column is one more
 * thing an unmodified `get` will narrow by for any player who asks, so widening the set should
 * be a visible diff rather than a consequence of editing a column definition. Nothing asserted
 * `filterableColumns` before this block, which is why a derivation that silently emptied it
 * shipped and only surfaced as a Blabber profile showing the wrong person.
 */
describe('shipped repositories — declared client filter policy', () => {
  it.each([
    /**
     * The MICA-137 regression, pinned. Both are `clientWritable: false` on purpose — a
     * handle is claimed once and never renamed or moved between apps — and the old derivation
     * read that as "not filterable either". `sanitizeFilter` then returned `{}`, so the paged
     * public read behind `getAccounts({ app: 'blabber', handle })` dropped both predicates and
     * answered with the newest account on the server, in any app.
     *
     * Neither widens what a stranger can learn. `handle` becomes an exact-match existence
     * check, and `searchAccounts` already answers a public substring `LIKE '%q%'` over the
     * same column — equality is strictly weaker. `app` only narrows a set the unfiltered
     * public read hands back in full, so it removes rows from a response rather than adding
     * information to one.
     */
    ['accounts', ['app', 'handle']],
    // Same shape, and the reason the bug was one re-enabled read away from spreading: each of
    // these is set at create and frozen so a post cannot be reattributed or re-parented, and
    // each is exactly what a profile feed or a thread narrows by. All four are already in
    // `publicColumns`, so filtering re-derives linkage the reader was handed anyway — and
    // `findAll`'s `IS NULL` branch exists for the top-level-feed filter, which is evidence
    // these were meant to be filterable before anything made them so.
    ['blabber', ['account_id', 'reply_to', 'mouth_of', 'root_id']],
    // Owner-scoped, and unreachable today — `disableGet` registers no generic read. Safe if
    // one is ever turned on: `ServiceEndpoint` forces `filter.citizenid` on every non-public
    // read *after* `sanitizeFilter`, so `app` can only ever partition the caller's own rows.
    ['notifications', ['app']],
    // The address book looks a contact up by number and filters the favourites list.
    ['contacts', ['phone', 'favorite']],
    ['conversations', []],
    ['mail', []],
    ['messages', []],
    ['notes', []],
    ['media', []],
    ['reports', []],
    ['battery', []],
    ['hodlr', []]
  ])('%s exposes exactly the expected filterable columns', (name, expected) => {
    const entry = ALL.find((candidate) => candidate.name === name)!;
    expect(entry.repo.filterableColumns).toEqual(expected);
  });

  it.each(ALL)('$name never lets a client filter on citizenid', ({ repo }) => {
    // The guarantee the decoupling had to keep, and it kept it without needing to try:
    // `citizenid` is an `IMPLICIT_COLUMNS` name, so `resolveAppSchema` throws on a schema
    // that declares it and no derivation can produce it. This asserts the property across the
    // shipped tables rather than the mechanism — `publicColumns` withholds `citizenid` so two
    // accounts cannot be correlated back to one player, and a filter would answer the same
    // question from the row count without the column ever being selected.
    expect(repo.filterableColumns).not.toContain('citizenid');
  });

  it.each(ALL)('$name never lets a client filter on status', ({ repo }) => {
    // `findAll` only defaults `status` to `'active'` when the filter does not name it, so a
    // filterable `status` hands soft-deleted and moderated rows back to any caller that asks.
    expect(repo.filterableColumns).not.toContain('status');
  });
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
    // The trailing bound parameter is the page size (MICA-197): this read had no `LIMIT`
    // at all, so opening Messages cost more every day a player used it.
    expect(dbMock.query.mock.calls[0][1]).toEqual(['CIT_A', 200]);
  });

  /**
   * MICA-197. `findForCitizen` returned every thread a player had ever been in, and each
   * returned row carried correlated subqueries — so the cost of the list grew without bound.
   * Keyset on `c.id DESC` rather than an offset, matching every other paged read here: a
   * thread created while somebody is paging shifts an offset and makes them see a row twice
   * or not at all.
   */
  it('findForCitizen is keyset-paged on id, and the cursor is a bound parameter', async () => {
    dbMock.query.mockResolvedValue([]);
    dbMock.query.mockClear();

    await (conversations.repo as any).findForCitizen('CIT_A', { limit: 25, cursor: 900 });

    const sql = String(dbMock.query.mock.calls[0][0]).replace(/\s+/g, ' ');
    expect(sql).toContain('AND c.`id` < ?');
    expect(sql).toContain('ORDER BY c.id DESC');
    expect(sql).toContain('LIMIT ?');
    expect(dbMock.query.mock.calls[0][1]).toEqual(['CIT_A', 900, 25]);
  });

  it('findForCitizen omits the cursor clause entirely on the first page', async () => {
    dbMock.query.mockResolvedValue([]);
    dbMock.query.mockClear();

    await (conversations.repo as any).findForCitizen('CIT_A', { limit: 25, cursor: null });

    const sql = String(dbMock.query.mock.calls[0][0]).replace(/\s+/g, ' ');
    expect(sql).not.toContain('c.`id` < ?');
    expect(dbMock.query.mock.calls[0][1]).toEqual(['CIT_A', 25]);
  });

  /**
   * The participants of a whole page of threads, in one statement. This was one query per
   * conversation, and it hard-coded `LEFT JOIN players` — a qb table es_extended does not
   * have, so the Messages list threw outright on ESX. The join now comes from
   * `FrameworkBridge.ownerNameProjection`.
   */
  it('findParticipantsForConversations asks once for every conversation id', async () => {
    dbMock.query.mockResolvedValue([]);
    dbMock.query.mockClear();

    await (conversations.repo as any).findParticipantsForConversations([4, 5, 6]);

    expect(dbMock.query).toHaveBeenCalledTimes(1);
    const sql = String(dbMock.query.mock.calls[0][0]).replace(/\s+/g, ' ');
    expect(sql).toContain('p.`conversation_id` IN (?, ?, ?)');
    expect(sql).toContain('p.`left_at` IS NULL');
    expect(dbMock.query.mock.calls[0][1]).toEqual([4, 5, 6]);
  });

  it('findParticipantsForConversations deduplicates ids and asks nothing for none', async () => {
    dbMock.query.mockResolvedValue([]);
    dbMock.query.mockClear();

    await (conversations.repo as any).findParticipantsForConversations([4, 4, 4]);
    expect(dbMock.query.mock.calls[0][1]).toEqual([4]);

    dbMock.query.mockClear();
    await (conversations.repo as any).findParticipantsForConversations([]);
    expect(dbMock.query).not.toHaveBeenCalled();
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
