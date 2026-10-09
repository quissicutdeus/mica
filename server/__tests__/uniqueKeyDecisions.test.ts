// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from 'vitest';

const { dbMock } = vi.hoisted(() => ({
  dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() }
}));
vi.mock('../lib/Database', () => ({ Database: dbMock }));

import {
  declaredServices,
  normalizeIndex,
  resolveAppSchema,
  type ResolvedService
} from '../lib/defineService';
import '../services/index';

/**
 * Every unique key on a declared table has a decision for the row a soft delete leaves under it
 * (MICA-321).
 *
 * `Repository.delete` is soft, so a deleted row keeps every unique key it is under, and creating
 * the same row again is a duplicate-key error the player sees as the generic failure. MICA-318
 * found it on the blocklist only because `test:endpoints` blocked, unblocked and blocked again;
 * no unit suite can see it, because the mocked `Database` answers every insert. So the question
 * is asked of the declaration instead: a table that declares a unique key says `'revive'` or
 * `{ optOut: '<reason>' }`, and a child table, which has no repository to revive through, says
 * why it may opt out.
 *
 * A missing decision fails here rather than at `defineService`, so an add-on declaring a service
 * is not refused at start by a rule it never saw.
 */
const undecided = (services: readonly ResolvedService[]): string[] => {
  const missing: string[] = [];
  for (const service of services) {
    const keys = service.indexes.filter((index) => index.unique);
    if (keys.length > 0 && service.uniqueAfterDelete === null) {
      missing.push(`${service.table} (${keys.map((k) => k.name).join(', ')})`);
    }
    for (const child of service.childTables) {
      const childKeys = (child.indexes ?? []).map(normalizeIndex).filter((index) => index.unique);
      if (childKeys.length > 0 && child.uniqueAfterDelete === undefined) {
        missing.push(`${child.name} (${childKeys.map((k) => k.name).join(', ')})`);
      }
    }
  }
  return missing;
};

const withUniqueKey = declaredServices.filter(
  (service) =>
    service.indexes.some((index) => index.unique) ||
    service.childTables.some((child) =>
      (child.indexes ?? []).some((index) => normalizeIndex(index).unique)
    )
);

describe('unique keys and soft deletes (MICA-321)', () => {
  it('gives every unique key on a declared table a decision', () => {
    expect(undecided(declaredServices)).toEqual([]);
  });

  it('is reading the real declarations, not an empty list', () => {
    // A mocked-away or reordered import graph would leave nothing to check, and pass.
    expect(withUniqueKey.map((service) => service.id).sort()).toEqual(
      expect.arrayContaining([
        'accounts',
        'battery',
        'blabber',
        'blocklist',
        'conversations',
        'devices',
        'highscores',
        'hodlr',
        'importledger',
        'lockscreen',
        'messages',
        'phonenumbers',
        'settings'
      ])
    );
  });

  it('fails a table that declares a unique key and no decision', () => {
    const resolved = resolveAppSchema({
      id: 'undecided_table',
      schema: { label: 'string' },
      indexes: [{ name: 'label_unique', columns: ['label'], unique: true }]
    });
    expect(undecided([resolved])).toEqual(['mica_undecided_table (label_unique)']);
  });

  it('fails a child table that declares a unique key and no decision', () => {
    const resolved = resolveAppSchema({
      id: 'undecided_child',
      schema: { label: 'string' },
      childTables: [
        {
          name: 'mica_undecided_child_links',
          columns: { a: 'int', b: 'int' },
          indexes: [{ name: 'a_b', columns: ['a', 'b'], unique: true }]
        }
      ]
    });
    expect(undecided([resolved])).toEqual(['mica_undecided_child_links (a_b)']);
  });

  it('passes the same tables once each has decided', () => {
    const resolved = resolveAppSchema({
      id: 'decided_table',
      schema: { label: 'string' },
      indexes: [{ name: 'label_unique', columns: ['label'], unique: true }],
      uniqueAfterDelete: 'revive',
      childTables: [
        {
          name: 'mica_decided_table_links',
          columns: { a: 'int', b: 'int' },
          indexes: [{ name: 'a_b', columns: ['a', 'b'], unique: true }],
          uniqueAfterDelete: { optOut: 'hard-deleted, so a removal frees the key' }
        }
      ]
    });
    expect(undecided([resolved])).toEqual([]);
  });

  it('revives on exactly the tables whose code creates a row a delete could wedge', () => {
    const revivers = declaredServices
      .filter((service) => service.uniqueAfterDelete === 'revive')
      .map((service) => service.id)
      .sort();
    expect(revivers).toEqual(['battery', 'blocklist', 'hodlr']);
  });
});
