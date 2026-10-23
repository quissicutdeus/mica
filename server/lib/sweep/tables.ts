// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { AUDIT_LOG_TABLE } from '../AuditLogger';
import { declaredServices, type ColumnDef, type ColumnType } from '../defineService';

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
 * Further child tables hang off micaOS's *own* tables rather than off the owner
 * (`mica_account_follows` → `mica_accounts(id)`, and friends). They are deliberately not
 * here: they carry no citizenid to key on, and they stay as they are when the row they hang off
 * is erased (MICA-428) — nothing is deleted, so nothing cascades.
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
 * Whether `table` has a `status` column a purge can move (MICA-428). Every declared primary
 * table does; a child table only when it declares one. A table without one is left alone by
 * every purge until it gets one (MICA-429), and so is the audit ledger, which has none.
 */
export const hasStatus = (table: string): boolean => {
  for (const service of declaredServices) {
    if (service.table === table) return true;
    const child = service.childTables.find((c) => c.name === table);
    if (child) return child.columns.status !== undefined;
  }
  return false;
};

/**
 * Whether `table` has an `updated_at` an erase must pin. Every declared primary table does; a
 * child table only when it declares one — `mica_darkchat_members` has a status and none.
 */
export const hasUpdatedAt = (table: string): boolean => {
  for (const service of declaredServices) {
    if (service.table === table) return true;
    const child = service.childTables.find((c) => c.name === table);
    if (child) return child.columns.updated_at !== undefined;
  }
  return false;
};
