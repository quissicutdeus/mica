// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { AUDIT_LOG_TABLE } from '../AuditLogger';
import { declaredServices, type ColumnDef, type ColumnType } from '../defineService';
import { OWNER_TABLE } from '../schemaSql';
import { identifier } from './sql';

/** The column every micaOS table names its owner in. */
const OWNER_COLUMN = 'citizenid';

/** A micaOS table and the column in it that names the character the rows belong to. */
export interface OwnedTable {
  table: string;
  column: string;
}

const asColumnDef = (spec: ColumnType | ColumnDef): ColumnDef =>
  typeof spec === 'string' ? { type: spec } : spec;

/**
 * Every table whose rows belong to a character, derived rather than listed.
 *
 * A hand-written list is a list that goes stale the next time somebody declares a service,
 * and it goes stale silently — the new table simply never gets swept, which reads exactly
 * like a table with nothing to sweep. So the set comes from the declarations:
 *
 * - **Every declared service's primary table.** `citizenid` is one of the five columns
 *   `defineService` supplies, so every one of them has an owner.
 * - **Every child table that declares a `citizenid` column of its own** — the owner column's
 *   name, with the `citizenId` flag that sizes it. Child tables are DDL-only — no repository,
 *   no events — and five of them (`mica_messages_participants`, the reactions on a message,
 *   and the three attachment tables) carry their own owner. A derivation that walked only
 *   `declaredServices` would miss all five; `SchemaMigrator` walks both levels for the same
 *   reason. Until MICA-300 these were found by their foreign key onto `players`; that key is
 *   gone, and the column name is the same test the primary tables have always passed.
 * - **`mica_audit_logs`**, which has no declaration behind it — see `AUDIT_LOG_TABLE`.
 *
 * Six further child tables hang off micaOS's *own* tables rather than off the owner
 * (`mica_account_follows` → `mica_accounts(id)`, and friends). They are deliberately not
 * here: they carry no citizenid to key on, and their rows go with the parent by its foreign
 * key — when the plan lets the parent go (`CascadeOptions.dependents`). That is also why this
 * must issue real per-table `DELETE`s and never a `TRUNCATE` or anything under
 * `FOREIGN_KEY_CHECKS = 0` — either would orphan those six permanently, with nothing left to
 * find them by.
 *
 * Computed on call, never at module scope: `declaredServices` is filled as a side effect of
 * each `defineService`, so a value captured at import time holds only the services that
 * happened to load first.
 */
export const ownedTables = (): OwnedTable[] => {
  const out: OwnedTable[] = [];
  const seen = new Set<string>();
  const add = (table: string, column: string): void => {
    if (seen.has(table)) return;
    seen.add(table);
    out.push({ table, column });
  };

  for (const service of declaredServices) {
    add(service.table, OWNER_COLUMN);
    for (const child of service.childTables) {
      const owner = child.columns[OWNER_COLUMN];
      if (owner !== undefined && asColumnDef(owner).citizenId === true) {
        add(child.name, OWNER_COLUMN);
      }
    }
  }

  add(AUDIT_LOG_TABLE, OWNER_COLUMN);

  return out;
};

/**
 * Something an owned table's rows name outside the database — a photo on an image host
 * (MICA-243) — which must be released when the rows go, or it outlives them. MICA-292.
 *
 * The same two halves as retention's `RetentionExternal`, for the same reasons: `collect`
 * runs **before** the delete, since afterwards the rows and the reference are gone, and if it
 * throws that table is not deleted from at all — deleting the rows would strand whatever they
 * named. `release` runs after, with what `collect` answered, and decides for itself what is
 * still referenced, so collecting more than was deleted is safe and collecting less is the
 * only failure. It is caught and logged: the rows are already gone.
 *
 * `where` is SQL that is true for exactly the rows about to be deleted, qualifying the row
 * as `t`, with its parameters in order. It is built here from declared identifiers only.
 */
export interface OwnedExternal {
  collect: (
    where: { sql: string; params: readonly unknown[] },
    limit: number
  ) => Promise<readonly string[]>;
  release: (refs: readonly string[]) => Promise<void>;
}

export const externals = new Map<string, OwnedExternal>();

/**
 * Register what an owned table's rows name outside the database. Called by the owning service,
 * once — `server/lib` names no service's table itself (`sdk/coreBoundary.test.ts`).
 */
export const registerOwnedExternal = (table: string, external: OwnedExternal): void => {
  identifier(table, 'an owned table');
  if (externals.has(table)) {
    throw new Error(`registerOwnedExternal: '${table}' is already registered.`);
  }
  externals.set(table, external);
};

/** A foreign key between two micaOS tables: `child.column` references `parent.parentColumn`. */
export interface CascadeEdge {
  child: string;
  column: string;
  parent: string;
  parentColumn: string;
  onDelete: 'CASCADE' | 'SET NULL' | 'RESTRICT';
}

/**
 * Every foreign key from one micaOS table to another, derived from the declarations — the same
 * walk `ownedTables` makes. `SET NULL` and `RESTRICT` are kept too: the first rewrites another
 * player's row, the second would fail the delete, and neither is something a purge should
 * reach into blind. A reference to the framework's owner table is not one of these; micaOS
 * declares none since MICA-300, and `schemaSql` refuses to emit one.
 */
export const cascadeEdges = (): CascadeEdge[] => {
  const out: CascadeEdge[] = [];
  const add = (child: string, column: string, spec: ColumnType | ColumnDef): void => {
    const ref = asColumnDef(spec).references;
    if (!ref || ref.table === OWNER_TABLE) return;
    out.push({
      child,
      column,
      parent: ref.table,
      parentColumn: ref.column,
      onDelete: ref.onDelete ?? 'CASCADE'
    });
  };
  for (const service of declaredServices) {
    for (const { name, def } of service.fields) add(service.table, name, def);
    for (const child of service.childTables) {
      for (const [name, spec] of Object.entries(child.columns)) add(child.name, name, spec);
    }
  }
  return out;
};
