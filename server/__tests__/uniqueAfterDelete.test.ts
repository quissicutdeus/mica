// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { dbMock } = vi.hoisted(() => ({
  dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() }
}));
vi.mock('../lib/Database', () => ({ Database: dbMock }));

import {
  buildRepository,
  defineService,
  resolveAppSchema,
  SchemaRepository,
  type ColumnDef,
  type ServiceDefinition
} from '../lib/defineService';
import { Repository } from '../lib/Repository';

/**
 * `uniqueAfterDelete` (MICA-321): a `create` that would collide with the caller's own
 * soft-deleted row under a unique key revives that row instead.
 *
 * The mocked `Database` answers every insert, so it cannot see a duplicate-key refusal at all.
 * These run against a stand-in for the table that keeps its unique keys the way MariaDB does and
 * reads only the statements the repository sends — a statement it does not recognise fails the
 * test rather than answering. `test:endpoints` proves the same thing against MariaDB, through
 * the blocklist's handler.
 */

type Row = Record<string, unknown> & { id: number; status: string };

/** A table: its rows, its unique keys, and the defaults an insert or a `= DEFAULT` takes. */
const standIn = (
  table: string,
  uniqueKeys: readonly (readonly string[])[],
  defaults: Record<string, unknown>
) => {
  const rows: Row[] = [];
  /** The key `candidate` would break; `self` is the row it replaces, on an update. */
  const collides = (candidate: Row, self?: Row) =>
    uniqueKeys.find((key) =>
      rows.some(
        (row) =>
          row !== self &&
          key.every((c) => candidate[c] !== null && candidate[c] !== undefined) &&
          key.every((c) => row[c] === candidate[c])
      )
    );

  /** `\`a\` = ? AND \`b\` <=> ?` against a row, consuming params from the front. */
  const matches = (clause: string, row: Row, params: unknown[]): boolean => {
    let ok = true;
    for (const [, column, op] of clause.matchAll(/`(\w+)` (=|<=>) \?/g)) {
      const value = params.shift();
      const cell = row[column] ?? null;
      if (op === '<=>' ? cell !== (value ?? null) : value === null || cell !== value) ok = false;
    }
    for (const [, column, literal] of clause.matchAll(/`(\w+)` = '(\w+)'/g)) {
      if (row[column] !== literal) ok = false;
    }
    return ok;
  };

  dbMock.insert.mockImplementation(async (sql: string, params: unknown[]) => {
    const m = /^INSERT INTO `(\w+)` \((.+)\) VALUES \([?, ]+\)$/.exec(sql);
    expect(m?.[1]).toBe(table);
    const columns = [...m![2].matchAll(/`(\w+)`/g)].map((x) => x[1]);
    const row: Row = { ...defaults, id: rows.length + 1, status: 'active' };
    columns.forEach((c, i) => (row[c] = params[i]));
    const key = collides(row);
    if (key) throw new Error(`Duplicate entry for key '${key.join('_')}'`);
    rows.push(row);
    return row.id;
  });

  dbMock.scalar.mockImplementation(async (sql: string, params: unknown[]) => {
    const m = new RegExp(
      `^SELECT \`id\` FROM \`${table}\` WHERE (.+) AND \\(\\((.+)\\)\\) ORDER BY \`id\` LIMIT 1$`
    ).exec(sql);
    if (!m) throw new Error(`stand-in does not know: ${sql}`);
    const [, owner, keys] = m;
    const hit = rows.find((row) => {
      const p = [...params];
      if (!matches(owner, row, p)) return false;
      return keys.split(') OR (').some((group) => {
        const groupParams = p.splice(0, [...group.matchAll(/\?/g)].length);
        return matches(group, row, groupParams);
      });
    });
    return hit ? hit.id : null;
  });

  dbMock.update.mockImplementation(async (sql: string, params: unknown[]) => {
    const m = new RegExp(`^UPDATE \`${table}\` SET (.+) WHERE (.+)$`).exec(sql);
    if (!m) throw new Error(`stand-in does not know: ${sql}`);
    const [, set, where] = m;
    const assignments = set.split(', ').map((a) => /^`(\w+)` = (.+)$/.exec(a)!.slice(1));
    const setParams = params.slice(0, assignments.filter(([, v]) => v === '?').length);
    const whereParams = params.slice(setParams.length);
    const row = rows.find((r) => matches(where, r, [...whereParams]));
    if (!row) return false;
    const next: Row = { ...row };
    for (const [column, value] of assignments) {
      if (value === '?') next[column] = setParams.shift();
      else if (value === 'DEFAULT') next[column] = defaults[column] ?? null;
      else if (value === 'CURRENT_TIMESTAMP') next[column] = 'now';
      else next[column] = value.replace(/^'(.*)'$/, '$1');
    }
    const key = collides(next, row);
    if (key) throw new Error(`Duplicate entry for key '${key.join('_')}'`);
    Object.assign(row, next);
    return true;
  });

  return rows;
};

/** A device-owned table like the blocklist: one row per (phone, number), with a note on it. */
const deviceTable: ServiceDefinition = {
  id: 'revive_device',
  deviceOwned: true,
  schema: {
    number: { type: 'string', length: 32, notNull: true },
    note: { type: 'string', length: 64, default: 'none' },
    shown: {
      type: 'string',
      length: 32,
      generatedAs: 'UPPER(`number`)'
    }
  },
  indexes: [{ name: 'device_number_unique', columns: ['device_id', 'number'], unique: true }],
  uniqueAfterDelete: 'revive'
};

/** A citizen-owned table like Hodlr: one row per player. */
const citizenTable: ServiceDefinition = {
  id: 'revive_citizen',
  schema: { quantity: { type: 'int', notNull: true, default: 0 } },
  indexes: [{ name: 'citizenid_unique', columns: ['citizenid'], unique: true }],
  uniqueAfterDelete: 'revive'
};

const repoFor = (definition: ServiceDefinition) =>
  buildRepository<Record<string, unknown>>(resolveAppSchema(definition));

const PHONE = '0123456789abcdef0123456789abcdef';
const OTHER_PHONE = 'fedcba9876543210fedcba9876543210';

beforeEach(() => {
  vi.resetAllMocks();
});

describe('uniqueAfterDelete: revive', () => {
  it("revives the caller's own deleted row under the key instead of inserting", async () => {
    const rows = standIn('mica_revive_device', [['device_id', 'number']], { note: 'none' });
    const repo = repoFor(deviceTable);

    const first = await repo.create({ citizenid: 'CIT_A', device_id: PHONE, number: '5550100' });
    rows[0].status = 'deleted';
    const again = await repo.create({ citizenid: 'CIT_A', device_id: PHONE, number: '5550100' });

    expect(again).toBe(first);
    expect(dbMock.insert).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: first, status: 'active', created_at: 'now' });
  });

  it('is a plain insert, and the key still refuses, when the table opted out', async () => {
    const rows = standIn('mica_revive_optout', [['device_id', 'number']], {});
    const repo = repoFor({
      ...deviceTable,
      id: 'revive_optout',
      uniqueAfterDelete: { optOut: 'refused on purpose, for this test' }
    });
    rows.push({
      id: 1,
      citizenid: 'CIT_A',
      device_id: PHONE,
      number: '5550100',
      status: 'deleted'
    });

    await expect(
      repo.create({ citizenid: 'CIT_A', device_id: PHONE, number: '5550100' })
    ).rejects.toThrow(/Duplicate entry/);
    expect(dbMock.scalar).not.toHaveBeenCalled();
  });

  it('inserts when there is no deleted row to revive', async () => {
    const rows = standIn('mica_revive_device', [['device_id', 'number']], { note: 'none' });
    const repo = repoFor(deviceTable);

    expect(await repo.create({ citizenid: 'CIT_A', device_id: PHONE, number: '5550100' })).toBe(1);
    expect(await repo.create({ citizenid: 'CIT_A', device_id: PHONE, number: '5550199' })).toBe(2);
    expect(rows.map((r) => r.number)).toEqual(['5550100', '5550199']);
  });

  it("never revives another citizen's row under the same key", async () => {
    const rows = standIn('mica_revive_device', [['device_id', 'number']], { note: 'none' });
    const repo = repoFor(deviceTable);
    // The phone's previous holder unblocked the number and the rows have not followed it yet.
    rows.push({
      id: 1,
      citizenid: 'CIT_B',
      device_id: PHONE,
      number: '5550100',
      status: 'deleted'
    });

    await expect(
      repo.create({ citizenid: 'CIT_A', device_id: PHONE, number: '5550100' })
    ).rejects.toThrow(/Duplicate entry/);
    expect(rows).toEqual([
      { id: 1, citizenid: 'CIT_B', device_id: PHONE, number: '5550100', status: 'deleted' }
    ]);
  });

  it("never revives the same citizen's row from another phone", async () => {
    const rows = standIn('mica_revive_device', [['device_id', 'number']], { note: 'none' });
    const repo = repoFor(deviceTable);
    rows.push({
      id: 1,
      citizenid: 'CIT_A',
      device_id: OTHER_PHONE,
      number: '5550100',
      status: 'deleted'
    });

    expect(await repo.create({ citizenid: 'CIT_A', device_id: PHONE, number: '5550100' })).toBe(2);
    expect(rows.map((r) => [r.device_id, r.status])).toEqual([
      [OTHER_PHONE, 'deleted'],
      [PHONE, 'active']
    ]);
  });

  it('names the phone null-safely, so a phoneless create matches only a phoneless row', async () => {
    standIn('mica_revive_device', [['device_id', 'number']], { note: 'none' });
    const repo = repoFor({
      ...deviceTable,
      id: 'revive_phoneless',
      indexes: [{ name: 'citizen_number_unique', columns: ['citizenid', 'number'], unique: true }]
    });
    dbMock.scalar.mockResolvedValue(null);
    dbMock.insert.mockResolvedValue(9);

    await repo.create({ citizenid: 'CIT_A', number: '5550100' });
    const [sql, params] = dbMock.scalar.mock.calls[0];
    expect(sql).toContain('`citizenid` = ? AND `device_id` <=> ?');
    expect(params).toEqual(['CIT_A', null, 'CIT_A', '5550100']);
  });

  it('leaves a moderated row where the moderator put it', async () => {
    const rows = standIn('mica_revive_device', [['device_id', 'number']], { note: 'none' });
    const repo = repoFor(deviceTable);
    rows.push({
      id: 1,
      citizenid: 'CIT_A',
      device_id: PHONE,
      number: '5550100',
      status: 'moderated'
    });

    await expect(
      repo.create({ citizenid: 'CIT_A', device_id: PHONE, number: '5550100' })
    ).rejects.toThrow(/Duplicate entry/);
    expect(rows[0].status).toBe('moderated');
  });

  it('writes the revived row as the insert would have: named columns set, the rest defaulted', async () => {
    const rows = standIn('mica_revive_device', [['device_id', 'number']], { note: 'none' });
    const repo = repoFor(deviceTable);
    rows.push({
      id: 1,
      citizenid: 'CIT_A',
      device_id: PHONE,
      number: '5550100',
      note: 'from the deleted row',
      status: 'deleted'
    });

    await repo.create({ citizenid: 'CIT_A', device_id: PHONE, number: '5550100' });
    expect(rows[0]).toMatchObject({ note: 'none', status: 'active' });

    const [sql, params] = dbMock.update.mock.calls[0];
    expect(sql).toBe(
      'UPDATE `mica_revive_device` SET `number` = ?, `note` = DEFAULT, ' +
        "`status` = 'active', `created_at` = CURRENT_TIMESTAMP " +
        "WHERE `id` = ? AND `citizenid` = ? AND `device_id` <=> ? AND `status` = 'deleted'"
    );
    // The generated column is never assigned; the owner and phone are pinned, not rewritten.
    expect(sql).not.toContain('`shown`');
    expect(params).toEqual(['5550100', 1, 'CIT_A', PHONE]);
  });

  it('writes a column the create names over the deleted row', async () => {
    const rows = standIn('mica_revive_device', [['device_id', 'number']], { note: 'none' });
    const repo = repoFor(deviceTable);
    rows.push({
      id: 1,
      citizenid: 'CIT_A',
      device_id: PHONE,
      number: '5550100',
      note: 'old',
      status: 'deleted'
    });

    await repo.create({ citizenid: 'CIT_A', device_id: PHONE, number: '5550100', note: 'new' });
    expect(rows[0].note).toBe('new');
  });

  it('revives a citizen-owned row by its citizenid key', async () => {
    const rows = standIn('mica_revive_citizen', [['citizenid']], { quantity: 0 });
    const repo = repoFor(citizenTable);
    rows.push({ id: 4, citizenid: 'CIT_A', quantity: 12, status: 'deleted' });

    expect(await repo.create({ citizenid: 'CIT_A', quantity: 0 })).toBe(4);
    expect(rows).toEqual([
      { id: 4, citizenid: 'CIT_A', quantity: 0, status: 'active', created_at: 'now' }
    ]);
    // No phone column, so no phone in the predicate.
    expect(String(dbMock.scalar.mock.calls[0][0])).not.toContain('device_id');
  });

  it('falls through to the insert when a racing create revived the row first', async () => {
    const repo = repoFor(deviceTable);
    dbMock.scalar.mockResolvedValue(1);
    dbMock.update.mockResolvedValue(false);
    dbMock.insert.mockRejectedValue(new Error("Duplicate entry for key 'device_number_unique'"));

    await expect(
      repo.create({ citizenid: 'CIT_A', device_id: PHONE, number: '5550100' })
    ).rejects.toThrow(/Duplicate entry/);
    expect(dbMock.insert).toHaveBeenCalledTimes(1);
  });

  it('looks for nothing when the create leaves a key column empty or names no citizen', async () => {
    const repo = repoFor(deviceTable);
    dbMock.insert.mockResolvedValue(1);

    await repo.create({ citizenid: 'CIT_A', number: '5550100' }); // no phone: key incomplete
    await repo.create({ device_id: PHONE, number: '5550100' }); // no citizen: no owner
    await repo.create({ citizenid: '', device_id: PHONE, number: '5550100' });
    expect(dbMock.scalar).not.toHaveBeenCalled();
    expect(dbMock.insert).toHaveBeenCalledTimes(3);
  });

  it('checks the columns before it looks, so a bad key never reaches the lookup', async () => {
    const repo = repoFor(deviceTable);
    await expect(
      repo.create({ citizenid: 'CIT_A', device_id: PHONE, number: '1', evil: 1 })
    ).rejects.toThrow(/rejected unknown column 'evil'/);
    expect(dbMock.scalar).not.toHaveBeenCalled();
  });

  it('asks about every unique key the create fills, in one lookup', async () => {
    const repo = repoFor({
      id: 'revive_two_keys',
      deviceOwned: true,
      // Nullable: in one key of two, so a revive through the other would default it.
      schema: { number: { type: 'string', length: 16 } },
      indexes: [
        { name: 'number_unique', columns: ['number'], unique: true },
        { name: 'device_id_unique', columns: ['device_id'], unique: true }
      ],
      uniqueAfterDelete: 'revive'
    });
    dbMock.scalar.mockResolvedValue(null);
    dbMock.insert.mockResolvedValue(1);

    await repo.create({ citizenid: 'CIT_A', device_id: PHONE, number: '5550100' });
    const [sql, params] = dbMock.scalar.mock.calls[0];
    expect(sql).toContain('AND ((`number` = ?) OR (`device_id` = ?))');
    expect(params).toEqual(['CIT_A', PHONE, '5550100', PHONE]);
  });
});

describe('uniqueAfterDelete: the declaration', () => {
  const unique = [{ name: 'label_unique', columns: ['label'], unique: true }] as const;

  it('records the decision on the resolved service', () => {
    expect(resolveAppSchema(citizenTable).uniqueAfterDelete).toBe('revive');
    expect(
      resolveAppSchema({
        id: 'decided_out',
        schema: { label: 'string' },
        indexes: unique,
        uniqueAfterDelete: { optOut: 'taken for good, by design' }
      }).uniqueAfterDelete
    ).toEqual({ optOut: 'taken for good, by design' });
    expect(
      resolveAppSchema({ id: 'undecided', schema: { label: 'string' }, indexes: unique })
        .uniqueAfterDelete
    ).toBeNull();
  });

  it('refuses a decision on a table with no unique index', () => {
    expect(() =>
      resolveAppSchema({
        id: 'nothing_to_decide',
        schema: { label: 'string' },
        indexes: [['label']],
        uniqueAfterDelete: 'revive'
      })
    ).toThrow(/no unique index to decide for/);
    expect(() =>
      resolveAppSchema({
        id: 'nothing_to_opt_out',
        schema: { label: 'string' },
        uniqueAfterDelete: { optOut: 'there is nothing here at all' }
      })
    ).toThrow(/no unique index to decide for/);
  });

  it('refuses an opt-out with no reason worth the name', () => {
    for (const optOut of ['', '   ', 'because', undefined]) {
      expect(() =>
        resolveAppSchema({
          id: 'no_reason',
          schema: { label: 'string' },
          indexes: unique,
          uniqueAfterDelete: { optOut } as never
        })
      ).toThrow(/reason has to say why/);
    }
  });

  it('refuses a revive over a key that names an encrypted column', () => {
    expect(() =>
      resolveAppSchema({
        id: 'sealed_key',
        schema: { body: { type: 'string', length: 64, encrypted: true } },
        encryptionScope: [],
        indexes: [{ name: 'body_unique', columns: ['body'], unique: true }],
        uniqueAfterDelete: 'revive'
      })
    ).toThrow(/encrypted column 'body'/);
  });

  it('refuses a revive over a NOT NULL column with no default the revive could leave out', () => {
    const table = (label: ColumnDef, indexes: ServiceDefinition['indexes']) => () =>
      resolveAppSchema({
        id: 'revive_not_null',
        schema: { number: { type: 'string', length: 16, notNull: true }, label },
        indexes,
        uniqueAfterDelete: 'revive'
      });
    const onNumber = [{ name: 'number_unique', columns: ['number'], unique: true }];

    // The revive would write `label = DEFAULT`: an implicit '' where the insert is refused.
    expect(table({ type: 'string', notNull: true }, onNumber)).toThrow(
      /'label', which is NOT NULL with no default/
    );
    // A default, a nullable column, or one in the key the revive needs: nothing implicit.
    expect(table({ type: 'string', notNull: true, default: 'x' }, onNumber)).not.toThrow();
    expect(table({ type: 'string' }, onNumber)).not.toThrow();
    expect(
      table({ type: 'string', notNull: true }, [
        { name: 'number_label', columns: ['number', 'label'], unique: true }
      ])
    ).not.toThrow();
    // In one key of two: a revive through the other key would still default it.
    expect(
      table({ type: 'string', notNull: true }, [
        ...onNumber,
        { name: 'label_unique', columns: ['label'], unique: true }
      ])
    ).toThrow(/which is NOT NULL with no default/);
  });

  it('names its table through a read-only getter', () => {
    expect(repoFor(deviceTable).table).toBe('mica_revive_device');
  });

  it('lets a child table only opt out, and only beside a unique index', () => {
    const child = (extra: object) => ({
      id: 'with_child',
      schema: { label: 'string' as const },
      childTables: [
        {
          name: 'mica_with_child_links',
          columns: { a: 'int' as const, b: 'int' as const },
          ...extra
        }
      ]
    });
    expect(() =>
      resolveAppSchema(
        child({
          indexes: [{ name: 'a_b', columns: ['a', 'b'], unique: true }],
          uniqueAfterDelete: 'revive'
        })
      )
    ).toThrow(/can only opt out/);
    expect(() =>
      resolveAppSchema(
        child({ indexes: [['a']], uniqueAfterDelete: { optOut: 'hard-deleted, frees the key' } })
      )
    ).toThrow(/no unique index to decide for/);
    expect(() =>
      resolveAppSchema(
        child({
          indexes: [{ name: 'a_b', columns: ['a', 'b'], unique: true }],
          uniqueAfterDelete: { optOut: 'hard-deleted, frees the key' }
        })
      )
    ).not.toThrow();
  });

  it('hands a SchemaRepository its keys, and a subclass inherits them', () => {
    const resolved = resolveAppSchema(deviceTable);
    expect(buildRepository(resolved).revivesUnder).toEqual([['device_id', 'number']]);
    expect(new (class extends SchemaRepository<unknown> {})(resolved).revivesUnder).toEqual([
      ['device_id', 'number']
    ]);
    expect(
      buildRepository(
        resolveAppSchema({ ...deviceTable, uniqueAfterDelete: { optOut: 'not this one, no' } })
      ).revivesUnder
    ).toEqual([]);
  });

  it("refuses a 'revive' whose repositoryFactory built a repository that drops it", () => {
    (globalThis as Record<string, unknown>).onNet = () => {};
    class HandWritten extends Repository<unknown> {
      protected tableName = 'mica_hand_written_revive';
      protected columns = ['id', 'citizenid', 'label', 'status', 'created_at', 'updated_at'];
    }
    expect(() =>
      defineService({
        id: 'hand_written_revive',
        schema: { label: 'string' },
        indexes: unique,
        uniqueAfterDelete: 'revive',
        repositoryFactory: () => new HandWritten()
      })
    ).toThrow(/revives under no key/);
  });
});
