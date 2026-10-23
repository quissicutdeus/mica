// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { dbMock } = vi.hoisted(() => ({
  dbMock: {
    query: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    scalar: vi.fn(),
    single: vi.fn(),
    transaction: vi.fn()
  }
}));
vi.mock('../lib/Database', () => ({ Database: dbMock }));
/**
 * A sealed stand-in, `$mc1$<nonce>:<plaintext>`: two seals of the same words differ, as real
 * ones do, and open to the same text. The real cipher is `contentCipher.test.ts`'s to prove.
 */
vi.mock('../lib/contentCipher', async (original) => ({
  ...(await original<typeof import('../lib/contentCipher')>()),
  tryOpenContent: (_context: unknown, stored: string) =>
    stored.startsWith('$mc1$') ? stored.slice(stored.indexOf(':') + 1) : stored
}));

import { Repository } from '../lib/Repository';
import { defineService } from '../lib/defineService';
import {
  __setVersionReadForTests,
  assertSnapshotFits,
  isoOf,
  readVersions,
  SNAPSHOT_CAPACITY,
  versionContext,
  writeVersioned,
  type VersionedWrite
} from '../lib/versions';
import { PlayerFacingError } from '../lib/errors';
import { __setStatusWritesForTests } from '../lib/statusWrites';
import { registerEncryptedColumn, unregisterEncryptedColumnForTests } from '../lib/contentCipher';

/**
 * MICA-430: what an edit replaces is kept, in the edit's own transaction. These pin the
 * statements; `test:schema` holds them to what MariaDB does with them.
 */

const one = (sql: unknown): string => String(sql).replace(/\s+/g, ' ').trim();
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The batch the last transaction sent, one line each. */
const batch = (): { query: string; params: unknown[] }[] =>
  (dbMock.transaction.mock.calls.at(-1)?.[0] ?? []).map((q: any) => ({
    query: one(q.query),
    params: q.params ?? []
  }));

const write = (over: Partial<VersionedWrite> = {}): VersionedWrite => ({
  table: 'mica_notes',
  values: ['title'],
  context: ['citizenid'],
  hasUpdatedAt: true,
  where: '`id` = ? AND `citizenid` = ?',
  whereParams: [5, 'CIT_A'],
  next: { title: 'new' },
  reason: 'edit',
  editedBy: 'CIT_A',
  set: { sql: '`title` = ?', params: ['new'] },
  ...over
});

/** The rows `writeVersioned`'s first read finds: what the table holds before the edit. */
let stored: Record<string, unknown>[];

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.transaction.mockResolvedValue(true);
  dbMock.scalar.mockResolvedValue(1);
  stored = [{ id: 5, title: 'old', citizenid: 'CIT_A' }];
  __setVersionReadForTests(async () => stored.map((row) => ({ ...row })));
});

/** The guard each statement of the transaction ends in: the row as read, by id and value. */
const GUARD =
  ' AND ((`mica_notes`.`id` = ? AND CAST(`mica_notes`.`title` AS BINARY) <=> CAST(? AS BINARY)))';

describe('writeVersioned (MICA-430)', () => {
  it('reads, then locks, snapshots and writes the changed row in one transaction, in that order', async () => {
    expect(await writeVersioned(write())).toEqual({ changed: 1, applied: true });

    const [clock, lock, snapshot, update] = batch();
    expect(clock).toEqual({ query: 'SET @mica_versions_now = NOW()', params: [] });
    expect(lock.query).toBe(
      'SELECT `mica_notes`.`id` FROM `mica_notes` WHERE `id` = ? AND `citizenid` = ?' +
        GUARD +
        ' FOR UPDATE'
    );
    expect(lock.params).toEqual([5, 'CIT_A', 5, 'old']);
    expect(snapshot.query).toBe(
      'INSERT INTO `mica_versions` (`citizenid`, `source_table`, `source_id`, `edited_by`, ' +
        '`reason`, `snapshot`, `op_key`) SELECT `mica_notes`.`citizenid`, ?, `mica_notes`.`id`, ?, ?, ' +
        "JSON_OBJECT('values', JSON_OBJECT('title', `mica_notes`.`title`), 'context', " +
        "JSON_OBJECT('citizenid', `mica_notes`.`citizenid`), 'written_at', " +
        'UNIX_TIMESTAMP(`mica_notes`.`updated_at`)), ? ' +
        'FROM `mica_notes` WHERE `id` = ? AND `citizenid` = ?' +
        GUARD
    );
    const [table, editedBy, reason, opKey, ...where] = snapshot.params;
    expect([table, editedBy, reason, where]).toEqual([
      'mica_notes',
      'CIT_A',
      'edit',
      [5, 'CIT_A', 5, 'old']
    ]);
    expect(opKey).toMatch(/^[0-9a-f]{32}$/);
    expect(update).toEqual({
      query: 'UPDATE `mica_notes` SET `title` = ? WHERE `id` = ? AND `citizenid` = ?' + GUARD,
      params: ['new', 5, 'CIT_A', 5, 'old']
    });
    // Whether it applied, read back by the transaction's own key.
    expect(dbMock.scalar).toHaveBeenCalledWith(
      'SELECT COUNT(*) FROM `mica_versions` WHERE `source_table` = ? AND `op_key` = ?',
      ['mica_notes', opKey]
    );
  });

  /**
   * MICA-430 review: `NOW()` is per statement, so an edit at the very end of its window could
   * be versioned by one statement and refused by the next, and still answer as written. Every
   * statement now reads the transaction's one clock.
   */
  it('judges an edit window on one clock for the whole transaction', async () => {
    await writeVersioned(
      write({
        where: '`id` = ? AND `created_at` > NOW() - INTERVAL ? SECOND',
        whereParams: [5, 900]
      })
    );
    const [clock, lock, snapshot, update] = batch();
    expect(clock.query).toBe('SET @mica_versions_now = NOW()');
    for (const statement of [lock, snapshot, update]) {
      expect(statement.query).toContain('`created_at` > @mica_versions_now - INTERVAL ? SECOND');
      expect(statement.query).not.toContain('NOW()');
    }
  });

  /** MICA-430 review: a save that changes nothing keeps nothing, and still counts as saved. */
  it('writes no version for a save that changes no versioned value, and answers it applied', async () => {
    stored = [{ id: 5, title: 'new', citizenid: 'CIT_A' }];
    dbMock.update.mockResolvedValue(true);
    expect(await writeVersioned(write())).toEqual({ changed: 0, applied: true });
    expect(dbMock.transaction).not.toHaveBeenCalled();
    // Still written, for the columns beside it, and only while the value is what was read.
    expect(one(dbMock.update.mock.calls[0][0])).toBe(
      'UPDATE `mica_notes` SET `title` = ? WHERE `id` = ? AND `citizenid` = ?' + GUARD
    );
    expect(dbMock.update.mock.calls[0][1]).toEqual(['new', 5, 'CIT_A', 5, 'new']);
  });

  it('compares a sealed value as what it opens to, never as its ciphertext', async () => {
    registerEncryptedColumn({
      table: 'mica_notes',
      column: 'title',
      scope: [],
      hasUpdatedAt: true
    });
    try {
      stored = [{ id: 5, title: '$mc1$nonce-a:same words', citizenid: 'CIT_A' }];
      dbMock.update.mockResolvedValue(true);
      const same = await writeVersioned(write({ next: { title: 'same words' } }));
      expect(same).toEqual({ changed: 0, applied: true });
      expect(dbMock.transaction).not.toHaveBeenCalled();
      // The guard names the ciphertext as stored, so a re-seal in between is not overwritten.
      expect(dbMock.update.mock.calls[0][1]).toContain('$mc1$nonce-a:same words');

      const changed = await writeVersioned(write({ next: { title: 'other words' } }));
      expect(changed.changed).toBe(1);
      expect(dbMock.transaction).toHaveBeenCalledTimes(1);
    } finally {
      unregisterEncryptedColumnForTests('mica_notes', 'title');
    }
  });

  it('counts a column the write resets, and so does not name, as changed', async () => {
    stored = [{ id: 5, title: 'new', citizenid: 'CIT_A' }];
    expect(await writeVersioned(write({ next: {} }))).toEqual({ changed: 1, applied: true });
  });

  it('versions only the rows that change, and writes the rest under their own guard', async () => {
    stored = [
      { id: 5, title: 'old', citizenid: 'CIT_A' },
      { id: 6, title: 'new', citizenid: 'CIT_A' }
    ];
    dbMock.update.mockResolvedValue(true);
    await writeVersioned(write({ where: '`citizenid` = ?', whereParams: ['CIT_A'] }));
    const [, , snapshot] = batch();
    expect(snapshot.params.slice(-2)).toEqual([5, 'old']);
    expect(dbMock.update.mock.calls[0][1]).toEqual(['new', 'CIT_A', 6, 'new']);
  });

  it('answers 0 changed and not applied when the row moved after the read, twice', async () => {
    dbMock.scalar.mockResolvedValue(0);
    expect(await writeVersioned(write())).toEqual({ changed: 0, applied: false });
    // Read and tried again once, never more.
    expect(dbMock.transaction).toHaveBeenCalledTimes(2);
  });

  /**
   * MICA-430 re-review: two edits at once. The other committed between this one's read and its
   * write, so the guard missed; it reads again and writes over it, keeping what it replaced.
   */
  it('reads again and writes once more when another edit landed between the read and the write', async () => {
    let reads = 0;
    __setVersionReadForTests(async () => {
      reads += 1;
      return [{ id: 5, title: reads === 1 ? 'old' : 'the other edit', citizenid: 'CIT_A' }];
    });
    dbMock.scalar.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    expect(await writeVersioned(write())).toEqual({ changed: 1, applied: true });
    expect(reads).toBe(2);
    const [, , , update] = batch();
    // The second write is guarded by what the second read found.
    expect(update.params.slice(-2)).toEqual([5, 'the other edit']);
  });

  it('writes once more, unversioned, when the other edit left the value this one writes', async () => {
    let reads = 0;
    __setVersionReadForTests(async () => {
      reads += 1;
      return [{ id: 5, title: reads === 1 ? 'old' : 'new', citizenid: 'CIT_A' }];
    });
    dbMock.scalar.mockResolvedValue(0);
    dbMock.update.mockResolvedValue(true);
    expect(await writeVersioned(write())).toEqual({ changed: 0, applied: true });
    expect(dbMock.transaction).toHaveBeenCalledTimes(1);
  });

  it('answers not applied, and opens no transaction, when the predicate names no row', async () => {
    stored = [];
    expect(await writeVersioned(write())).toEqual({ changed: 0, applied: false });
    expect(dbMock.transaction).not.toHaveBeenCalled();
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it('throws when the transaction rolled back: no version, no write, and never a silent false', async () => {
    dbMock.transaction.mockResolvedValue(false);
    await expect(writeVersioned(write())).rejects.toThrow(/rolled back whole/);
    expect(dbMock.scalar).not.toHaveBeenCalled();
  });

  /** MICA-430 review: before `micaschema apply`, the player hears why, not "something went wrong". */
  it('refuses an edit before micaschema apply with a message the player can read', async () => {
    __setStatusWritesForTests(false);
    try {
      const refused = await writeVersioned(write()).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(PlayerFacingError);
      expect(refused).toMatchObject({ key: 'server.versions.notReady' });
      expect(dbMock.transaction).not.toHaveBeenCalled();
      expect(dbMock.update).not.toHaveBeenCalled();
    } finally {
      __setStatusWritesForTests(true);
    }
  });

  it('qualifies by the alias, so a where that reaches into another table reads nothing off it', async () => {
    stored = [{ id: 9, title: 'old', citizenid: 'CIT_A' }];
    await writeVersioned(
      write({
        table: 'mica_messages_conversations',
        alias: 'c',
        where: 'c.id = ?',
        whereParams: [9],
        set: { sql: 'c.title = ?', params: ['new'] }
      })
    );
    const [, lock, snapshot, update] = batch();
    expect(lock.query).toMatch(
      /^SELECT c\.`id` FROM `mica_messages_conversations` c WHERE c\.id = \? AND \(\(c\.`id` = \?/
    );
    expect(snapshot.query).toContain('SELECT c.`citizenid`, ?, c.`id`');
    expect(snapshot.query).toContain("JSON_OBJECT('title', c.`title`)");
    expect(snapshot.query).toContain('FROM `mica_messages_conversations` c WHERE c.id = ?');
    expect(update.query).toMatch(
      /^UPDATE `mica_messages_conversations` c SET c\.title = \? WHERE c\.id = \?/
    );
  });
  it('keeps beside a sealed value every column its seal binds', () => {
    registerEncryptedColumn({
      table: 'mica_versions_probe',
      column: 'body',
      scope: ['thread_id'],
      binding: 'device',
      hasUpdatedAt: true
    });
    try {
      expect(versionContext('mica_versions_probe', ['body', 'plain'], true).sort()).toEqual(
        ['citizenid', 'device_id', 'thread_id'].sort()
      );
      // A plaintext column binds nothing; the owner is kept for the purge.
      expect(versionContext('mica_versions_probe', ['plain'], true)).toEqual(['citizenid']);
    } finally {
      unregisterEncryptedColumnForTests('mica_versions_probe', 'body');
    }
  });
});

describe('the snapshot fits the ledger (MICA-430)', () => {
  it('refuses a table whose versioned columns could outgrow a snapshot', () => {
    expect(() => assertSnapshotFits('mica_big', { body: SNAPSHOT_CAPACITY })).toThrow(
      /could make a .*-byte snapshot/
    );
    expect(() => assertSnapshotFits('mica_open', { blob: null })).toThrow(/has no bound/);
    // The positive twin: a text column, six-fold for JSON's worst escaping, fits.
    expect(() => assertSnapshotFits('mica_text', { body: 65_535, title: 1020 })).not.toThrow();
  });

  it('refuses a declaration that versions a mediumtext, or a generated column', () => {
    expect(() =>
      defineService({
        id: 'versionprobe',
        schema: { blob: { type: 'mediumtext', versioned: true } },
        options: { disableGet: true, disableCreate: true, disableUpdate: true, disableDelete: true }
      })
    ).toThrow(/mica_versionprobe\.blob is versioned but has no bound/);
    expect(() =>
      defineService({
        id: 'versionprobe2',
        schema: {
          a: { type: 'int' },
          b: { type: 'int', generatedAs: '`a` + 1', versioned: true }
        },
        options: { disableGet: true, disableCreate: true, disableUpdate: true, disableDelete: true }
      })
    ).toThrow(/'b' is 'versioned' but generated/);
  });
});

/** A table that versions `title` and not `content`, and revives under `slug`. */
class VersionedRepo extends Repository<Record<string, unknown>> {
  protected tableName = 'mica_vtest';
  protected columns = [
    'id',
    'citizenid',
    'device_id',
    'slug',
    'title',
    'content',
    'status',
    'created_at',
    'updated_at'
  ];
  protected clientWritable = ['title', 'content', 'slug'];
  protected clientFilterable = [];
  protected versionedColumns = ['title'];
  protected reviveKeys = [['slug']];
  protected reviveResets = ['slug', 'title', 'content'];

  public unscoped(id: number, data: Record<string, unknown>) {
    return this.updateUnscoped(id, data, 'handover');
  }
}

describe('the Repository keeps what an update replaces (MICA-430)', () => {
  it("writes a version with an update that changes a versioned column, by the update's own predicate", async () => {
    const repo = new VersionedRepo();
    expect(await repo.update(5, { title: 'new', content: 'x' }, 'CIT_A')).toBe(true);

    const [, lock, snapshot, update] = batch();
    expect(update.query).toMatch(
      new RegExp(
        '^' +
          escape(
            'UPDATE `mica_vtest` SET `title` = ?, `content` = ? WHERE `id` = ? AND `citizenid` = ? ' +
              "AND `status` NOT IN ('moderated', 'erased', 'expired') AND ((`mica_vtest`.`id` = ?"
          )
      )
    );
    const where =
      "WHERE `id` = ? AND `citizenid` = ? AND `status` NOT IN ('moderated', 'erased', 'expired')";
    expect(lock.query).toContain(where);
    expect(snapshot.query).toContain(where);
    // Only the versioned column's old value, and who edited.
    expect(snapshot.query).toContain("JSON_OBJECT('title', `mica_vtest`.`title`)");
    expect(snapshot.query).not.toContain("'content'");
    expect(snapshot.params.slice(0, 3)).toEqual(['mica_vtest', 'CIT_A', 'edit']);
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it('answers false when the predicate refused it: no row versioned, none written', async () => {
    dbMock.scalar.mockResolvedValue(0);
    expect(await new VersionedRepo().update(5, { title: 'new' }, 'CIT_A')).toBe(false);
    stored = [];
    expect(await new VersionedRepo().update(5, { title: 'new' }, 'CIT_A')).toBe(false);
  });

  /** MICA-430 review: saving a note unchanged keeps no version, and still answers saved. */
  it('writes no version for a save that leaves the versioned column as it was', async () => {
    stored = [{ id: 5, title: 'same', citizenid: 'CIT_A' }];
    dbMock.update.mockResolvedValue(true);
    expect(await new VersionedRepo().update(5, { title: 'same', content: 'x' }, 'CIT_A')).toBe(
      true
    );
    expect(dbMock.transaction).not.toHaveBeenCalled();
    expect(one(dbMock.update.mock.calls[0][0])).toMatch(
      /^UPDATE `mica_vtest` SET `title` = \?, `content` = \?/
    );
  });

  it('writes no version, and no transaction, for an update that changes no versioned column', async () => {
    dbMock.update.mockResolvedValue(true);
    expect(await new VersionedRepo().update(5, { content: 'x' }, 'CIT_A')).toBe(true);
    expect(dbMock.transaction).not.toHaveBeenCalled();
    // Nor for a delete, which is a status change.
    await new VersionedRepo().delete(5, 'CIT_A');
    expect(dbMock.transaction).not.toHaveBeenCalled();
  });

  it('versions a privileged write as the server, with the reason it gives', async () => {
    await new VersionedRepo().unscoped(5, { title: 'x' });
    const [, , snapshot] = batch();
    expect(snapshot.params.slice(0, 3)).toEqual(['mica_vtest', null, 'handover']);
  });

  it('versions a revive, which writes over the deleted row', async () => {
    dbMock.scalar.mockResolvedValueOnce(5).mockResolvedValue(1);
    dbMock.insert.mockResolvedValue(99);
    const id = await new VersionedRepo().create({ citizenid: 'CIT_A', slug: 's', title: 'again' });
    expect(id).toBe(5);
    const [, , snapshot, update] = batch();
    expect(snapshot.params.slice(0, 3)).toEqual(['mica_vtest', 'CIT_A', 'revive']);
    expect(snapshot.query).toContain(
      "WHERE `id` = ? AND `citizenid` = ? AND `device_id` <=> ? AND `status` = 'deleted'"
    );
    expect(update.query).toMatch(/^UPDATE `mica_vtest` SET `slug` = \?, `title` = \?/);
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it("versions a phone's own row on a handover, and every other row is moved as it was", async () => {
    dbMock.update.mockResolvedValue(true);
    const repo = new VersionedRepo();
    await repo.transferDeviceRows('PHONE_X', 'CIT_B');
    expect(dbMock.transaction).not.toHaveBeenCalled();

    stored = [{ id: 3, citizenid: 'CIT_A' }];
    await repo.transferDeviceRows('PHONE_X', 'CIT_B', 'handover');
    const [, lock, snapshot, update] = batch();
    const where =
      "WHERE `device_id` = ? AND `citizenid` <> ? AND `status` NOT IN ('erased', 'expired', 'moderated')";
    expect(lock.query).toContain(where);
    expect(snapshot.query).toContain("JSON_OBJECT('citizenid', `mica_vtest`.`citizenid`)");
    expect(snapshot.params.slice(0, 3)).toEqual(['mica_vtest', null, 'handover']);
    expect(update.query).toBe(
      'UPDATE `mica_vtest` SET `citizenid` = ?, `updated_at` = `updated_at` ' +
        where +
        ' AND ((`mica_vtest`.`id` = ? AND CAST(`mica_vtest`.`citizenid` AS BINARY) <=> CAST(? AS BINARY)))'
    );
    expect(update.params).toEqual(['CIT_B', 'PHONE_X', 'CIT_B', 3, 'CIT_A']);
  });
});

/**
 * MICA-430 review: `replaced_at` came back ISO from a `Date` and `written_at` as MariaDB's
 * `YYYY-MM-DD hh:mm:ss` text, so one reply held two formats. Both are ISO now, whatever shape
 * oxmysql's typeCast hands over.
 */
describe('one timestamp format across the staff read (MICA-430)', () => {
  const ISO = '2026-01-01T00:00:00.000Z';

  it('reads seconds, milliseconds, their text, a Date and MariaDB text as one instant', () => {
    expect(isoOf(1767225600)).toBe(ISO);
    expect(isoOf('1767225600')).toBe(ISO);
    expect(isoOf('1767225600.000000')).toBe(ISO);
    expect(isoOf(1767225600000)).toBe(ISO);
    expect(isoOf(new Date(ISO))).toBe(ISO);
    // MariaDB's text is local time, as oxmysql reads it.
    expect(isoOf('2026-01-01 00:00:00')).toBe(new Date('2026-01-01T00:00:00').toISOString());
    expect([isoOf(null), isoOf(''), isoOf('not a time')]).toEqual([null, null, null]);
  });

  it('answers replaced_at and written_at in the same format', () => {
    const [version] = readVersions('mica_notes', [
      {
        id: 1,
        citizenid: 'CIT_A',
        edited_by: 'CIT_A',
        reason: 'edit',
        snapshot: JSON.stringify({ values: { title: 'old' }, context: {}, written_at: 1767225600 }),
        created_at: new Date('2026-02-01T00:00:00Z')
      }
    ]);
    expect([version.replaced_at, version.written_at]).toEqual(['2026-02-01T00:00:00.000Z', ISO]);
  });
});
