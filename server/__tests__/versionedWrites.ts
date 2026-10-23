// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { vi } from 'vitest';
import { __setVersionReadForTests } from '../lib/versions';

/** One versioned write a suite's stand-in saw (MICA-430), as `writeVersioned` sent it. */
export interface VersionedCall {
  table: string;
  editedBy: unknown;
  reason: unknown;
  /** The lock, the snapshot and the write, as sent: each ends in the read rows' guard. */
  lock: string;
  snapshot: string;
  snapshotParams: unknown[];
  update: string;
  updateParams: unknown[];
  /** Rows the write applied to, by the suite's own `update` stand-in. */
  applied: number;
}

/**
 * What a row held before the edit, unless a suite says otherwise: a value no edit writes, so
 * every versioned column counts as changed and the write is versioned, as it was before
 * `writeVersioned` learned to skip a save that changes nothing.
 */
export const BEFORE_THE_EDIT = '\u0000before the edit';

/** `writeVersioned`'s first read, as a stand-in row: its id, and every column it names. */
const standInRow = (query: string, params: readonly unknown[]): Record<string, unknown> => {
  const row: Record<string, unknown> = { id: params[0] ?? 1 };
  for (const [, column] of query.matchAll(/ AS `(\w+)`/g)) {
    if (column !== 'id') row[column] = BEFORE_THE_EDIT;
  }
  return row;
};

/**
 * The default first read, for a suite whose `vi.resetModules` loads a fresh `lib/versions`:
 * install it there with that module's own `__setVersionReadForTests`.
 */
export const standInRead = async (query: string, params: unknown[]): Promise<unknown> => [
  standInRow(query, params)
];

/**
 * A statement without the guard `writeVersioned` ends it with (the rows as read, by id and
 * value), and the guard's parameters: the write a suite's own `update` stand-in already knows.
 * `versions.test.ts` pins the guard, and `test:schema` proves it on MariaDB.
 */
export const withoutGuard = (
  query: string,
  params: readonly unknown[]
): { query: string; params: unknown[] } => {
  const cut = query.lastIndexOf(' AND ((');
  if (cut < 0) return { query, params: [...params] };
  const guarded = (query.slice(cut).match(/\?/g) ?? []).length;
  return { query: query.slice(0, cut), params: params.slice(0, params.length - guarded) };
};

const isVersionInsert = (query: unknown): boolean =>
  String(query).startsWith('INSERT INTO `mica_versions`');

/**
 * A suite's `Database` stand-in, taught MICA-430's versioned write: one transaction of the lock,
 * the snapshot and the write, then a read of how many versions it left.
 *
 * The write goes through the suite's own `update` stand-in, so whatever that suite already says a
 * write does — applies, or matches nothing — is what the versioned write does too; the snapshot
 * counts as written exactly when it applied, which is what the transaction guarantees on a real
 * engine (`test:schema` proves that half). A batch that is not a versioned write goes to the
 * suite's own `transaction`, if it has one. Install after any `resetAllMocks`.
 */
export const versionedWrites = (
  dbMock: Record<string, any>,
  options: {
    /** The rows the edit's predicate names, as the table holds them before it. */
    rows?: (query: string, params: readonly unknown[]) => Record<string, unknown>[];
  } = {}
): VersionedCall[] => {
  const calls: VersionedCall[] = [];
  __setVersionReadForTests(async (query, params) =>
    options.rows ? options.rows(query, params) : [standInRow(query, params)]
  );
  if (!dbMock.transaction) dbMock.transaction = vi.fn();
  const previous = dbMock.transaction.getMockImplementation?.();
  dbMock.transaction.mockImplementation(
    async (queries: { query: string; params?: unknown[] }[]) => {
      const insert = queries.find((q) => isVersionInsert(q.query));
      if (!insert) return previous ? await previous(queries) : true;
      const lock = queries.find((q) => q.query.endsWith('FOR UPDATE')) ?? queries[0];
      const write = withoutGuard(
        queries[queries.length - 1].query,
        queries[queries.length - 1].params ?? []
      );
      const result = await dbMock.update(write.query, write.params);
      const applied = typeof result === 'number' ? result : result ? 1 : 0;
      const params = insert.params ?? [];
      calls.push({
        table: String(params[0]),
        editedBy: params[1],
        reason: params[2],
        lock: lock.query,
        snapshot: insert.query,
        snapshotParams: params,
        update: write.query,
        updateParams: write.params,
        applied
      });
      // The read-back `writeVersioned` makes next: how many versions this transaction left.
      dbMock.scalar.mockImplementationOnce(async () => applied);
      return true;
    }
  );
  return calls;
};
