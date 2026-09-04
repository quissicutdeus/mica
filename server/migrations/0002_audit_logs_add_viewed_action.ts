// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Migration } from '../lib/migrations';
import { Database } from '../lib/Database';

/**
 * Widen `mica_audit_logs.action` to accept `'viewed'` (MICA-70): an admin reading
 * reported content, rather than acting on it.
 *
 * `mica_audit_logs` has no `defineService` behind it — it is emitted verbatim from
 * `scripts/framework-schema.sql`, the one `citizenid`-bearing table with no declaration —
 * so `SchemaMigrator`'s additive pass never looks at it (`declaredServices` does not know
 * it exists) and a widened enum here gets no help from that machinery at all. It still
 * needs the same thing any other app table's widened enum would (AGENTS.md §8): a
 * versioned migration, because a retype is not inferable from a diff and the additive
 * planner would never attempt one even if it did know about this table.
 *
 * `MODIFY COLUMN` rather than `CHANGE COLUMN`: the column is not being renamed, only its
 * permitted values, and `MODIFY` is the narrower statement for that. No existing row is
 * touched — nothing has ever written `'viewed'` before this shipped, so there is nothing
 * to backfill. Safe to run twice: a `MODIFY COLUMN` to the definition a column already
 * has is a no-op, not an error, unlike the `ADD COLUMN`/`ADD KEY` this codebase's other
 * migrations guard with `information_schema` first.
 */
export const migration: Migration = {
  id: '0002_audit_logs_add_viewed_action',
  description:
    "widens mica_audit_logs.action to accept 'viewed' — an admin reading reported " +
    'content rather than acting on it',
  up: async () => {
    await Database.query(
      `ALTER TABLE \`mica_audit_logs\` MODIFY COLUMN \`action\` ENUM(
         'archived',
         'unarchived',
         'deleted',
         'left',
         'removed',
         'moderated',
         'unmoderated',
         'viewed'
       ) NOT NULL`,
      []
    );
  }
};
