// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { dbMock } = vi.hoisted(() => ({
  dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() }
}));
vi.mock('../lib/Database', () => ({ Database: dbMock }));

import type { Account } from '@mica/shared/types';
import { declaredServices, resolveAppSchema } from '../lib/defineService';
import { isReactableTable, reactableRule, reactableTables } from '../lib/reactions';
import '../services/index';

/**
 * Which tables a reaction may target, and the rule for each, used to be two hand-kept maps in
 * `services/Accounts.ts` naming other services' tables — an add-on's among them. MICA-391 moved
 * each rule onto the declaration that owns the table; these hold the derived set to the
 * declarations, and the moved rules to the SQL they ran before the move.
 */

const account = (over: Partial<Account> = {}): Account =>
  ({ id: 3, app: 'blabber', handle: 'ada', status: 'active', ...over }) as Account;

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.single.mockResolvedValue(null);
  dbMock.query.mockResolvedValue([]);
});

describe('the derived reactable set', () => {
  it('is exactly the declarations that opted in, and names the two there are', () => {
    // A mocked-away import graph would leave both sides empty and agreeing.
    expect(declaredServices.length).toBeGreaterThan(10);

    const declared = declaredServices.filter((s) => s.reactable).map((s) => s.table);
    expect([...reactableTables().keys()].sort()).toEqual([...declared].sort());
    // Pinned, so a declaration that loses its `reactable` — or one that gains it — is a
    // decision this file has to be edited for, not a silent change to who can react to what.
    expect([...reactableTables().keys()].sort()).toEqual(['mica_blabber_dms', 'mica_glimpse']);

    for (const service of declaredServices) {
      expect(isReactableTable(service.table), service.table).toBe(service.reactable !== null);
    }
  });

  it('refuses what no declaration names, and anything that is not a string', () => {
    expect(isReactableTable('mica_players')).toBe(false);
    expect(isReactableTable('mica_glimpse_comments')).toBe(false);
    expect(isReactableTable(undefined)).toBe(false);
    expect(isReactableTable(42)).toBe(false);
    // The positive twin: a declared table does pass.
    expect(isReactableTable('mica_glimpse')).toBe(true);
  });

  /** Identity reasons: an alias or a dating profile is not a thing to react to across. */
  it('leaves Dark Chat and Spark not reactable', () => {
    const tables = declaredServices
      .map((s) => s.table)
      .filter((t) => t.startsWith('mica_darkchat') || t.startsWith('mica_spark'));
    expect(tables.length).toBeGreaterThan(1);
    for (const table of tables) expect(isReactableTable(table), table).toBe(false);
  });

  it('reads the declarations at call time, not at import', () => {
    expect(isReactableTable('mica_late_loader')).toBe(false);
    const late = resolveAppSchema({
      id: 'late_loader',
      schema: { body: 'string' },
      reactable: {
        label: 'Late',
        canReact: async () => true,
        visibleTo: async (ids) => ids
      }
    });
    declaredServices.push(late);
    try {
      expect(isReactableTable('mica_late_loader')).toBe(true);
      expect(reactableTables().has('mica_late_loader')).toBe(true);
    } finally {
      declaredServices.splice(declaredServices.indexOf(late), 1);
    }
  });

  it('refuses an empty emoji list at declaration, since it would refuse every reaction', () => {
    expect(() =>
      resolveAppSchema({
        id: 'mute',
        schema: { body: 'string' },
        reactable: {
          label: 'Mute',
          emoji: [],
          canReact: async () => true,
          visibleTo: async (ids) => ids
        }
      })
    ).toThrow(/'reactable.emoji' is empty/);
  });
});

describe('a direct message (DirectMessages.ts)', () => {
  const rule = () => reactableRule('mica_blabber_dms')!;

  it('takes the open palette', () => {
    expect(rule().emoji).toBeUndefined();
  });

  it('lets either end react, with the SQL Accounts ran before the move', async () => {
    dbMock.single.mockImplementation(async (sql: string) =>
      sql.includes('`mica_blabber_dms`') ? { from_account: 8, to_account: 3 } : null
    );

    expect(await rule().canReact(account(), 4)).toBe(true);
    expect(dbMock.single.mock.calls[0]).toEqual([
      'SELECT `from_account`, `to_account` FROM `mica_blabber_dms` ' +
        "WHERE `id` = ? AND `status` = 'active' LIMIT 1",
      [4]
    ]);
  });

  it('refuses a DM between two other accounts, and a missing one', async () => {
    dbMock.single.mockImplementation(async (sql: string) =>
      sql.includes('`mica_blabber_dms`') ? { from_account: 8, to_account: 9 } : null
    );
    expect(await rule().canReact(account(), 4)).toBe(false);

    dbMock.single.mockResolvedValue(null);
    expect(await rule().canReact(account(), 4)).toBe(false);
  });

  it('refuses across a block in either direction', async () => {
    for (const blocked of [
      [3, 8],
      [8, 3]
    ]) {
      dbMock.single.mockImplementation(async (sql: string, params: unknown[]) => {
        if (sql.includes('`mica_blabber_dms`')) return { from_account: 3, to_account: 8 };
        if (sql.includes('`mica_account_blocks`'))
          return params[0] === blocked[0] && params[1] === blocked[1] ? { id: 1 } : null;
        return null;
      });
      expect(await rule().canReact(account(), 4), JSON.stringify(blocked)).toBe(false);
    }
  });

  it('shows only the viewer’s own DMs, with the SQL Accounts ran before the move', async () => {
    dbMock.query.mockResolvedValue([{ id: 4 }]);

    expect(await rule().visibleTo([4, 6], 'CIT_A', 'blabber')).toEqual([4]);
    expect(dbMock.query.mock.calls[0]).toEqual([
      `SELECT d.\`id\` FROM \`mica_blabber_dms\` d
         WHERE d.\`id\` IN (?, ?) AND d.\`status\` = 'active'
           AND EXISTS (SELECT 1 FROM \`mica_accounts\` a
                       WHERE a.\`citizenid\` = ? AND a.\`app\` = ? AND a.\`status\` = 'active'
                         AND a.\`id\` IN (d.\`from_account\`, d.\`to_account\`))`,
      [4, 6, 'CIT_A', 'blabber']
    ]);
  });
});

describe('a Glimpse post (Glimpse.ts)', () => {
  const rule = () => reactableRule('mica_glimpse')!;

  it('takes a ❤️ and nothing else, with the variation selector', () => {
    expect(rule().emoji).toEqual(['❤️']);
  });

  it('refuses an account from another app before reading anything', async () => {
    expect(await rule().canReact(account({ app: 'blabber' }), 4)).toBe(false);
    expect(dbMock.single).not.toHaveBeenCalled();
  });

  it('lets a Glimpse account like a live post, with the SQL Accounts ran before', async () => {
    dbMock.single.mockImplementation(async (sql: string) =>
      sql.includes('`mica_glimpse`') ? { account_id: 8 } : null
    );

    expect(await rule().canReact(account({ app: 'glimpse' }), 4)).toBe(true);
    expect(dbMock.single.mock.calls[0]).toEqual([
      "SELECT `account_id` FROM `mica_glimpse` WHERE `id` = ? AND `status` = 'active' LIMIT 1",
      [4]
    ]);
  });

  it('refuses a like across a block, in either direction', async () => {
    for (const blocked of [
      [3, 8],
      [8, 3]
    ]) {
      dbMock.single.mockImplementation(async (sql: string, params: unknown[]) => {
        if (sql.includes('`mica_glimpse`')) return { account_id: 8 };
        if (sql.includes('`mica_account_blocks`'))
          return params[0] === blocked[0] && params[1] === blocked[1] ? { id: 1 } : null;
        return null;
      });
      expect(await rule().canReact(account({ app: 'glimpse' }), 4), String(blocked)).toBe(false);
    }
  });

  it('shows likes on any live post, with the SQL Accounts ran before', async () => {
    dbMock.query.mockResolvedValue([{ id: 4 }, { id: 6 }]);

    expect(await rule().visibleTo([4, 6], 'CIT_A', 'glimpse')).toEqual([4, 6]);
    expect(dbMock.query.mock.calls[0]).toEqual([
      `SELECT \`id\` FROM \`mica_glimpse\`
         WHERE \`id\` IN (?, ?) AND \`status\` = 'active'`,
      [4, 6]
    ]);
  });
});
