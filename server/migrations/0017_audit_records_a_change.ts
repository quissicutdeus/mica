// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Migration } from '../lib/migrations';
import { Database } from '../lib/Database';

/**
 * `mica_audit_logs.action` as MICA-430 shipped it, frozen: the list before it, with `changed`
 * appended. Appended, never reordered, so the change is MariaDB's in-place ENUM append and no
 * row is rewritten.
 */
const ACTIONS = [
  'archived',
  'unarchived',
  'deleted',
  'left',
  'removed',
  'moderated',
  'unmoderated',
  'viewed',
  'changed'
] as const;

/** The values of an `enum('a','b')` column type, as information_schema spells it. */
const enumValues = (type: string): string[] | null => {
  const match = /^enum\((.*)\)$/i.exec(type.trim());
  if (!match) return null;
  return [...match[1].matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));
};

/**
 * MICA-430: the audit ledger records a credential replaced — a phone's passcode, a Dark Chat
 * channel's join code — as `changed`, in place of keeping its old value. Every other edit of a
 * player's content keeps what it replaced in the version ledger; a credential's history would be
 * a history of secrets, so only the fact that it changed, by whom and when, is kept.
 *
 * One read of `information_schema` and, if needed, one `ALTER` (MICA-428's lesson: in game every
 * read waits for a server tick). **Safe to run twice**: an ENUM already ending in `changed` is
 * left alone. One that is not the start of the list is refused before anything is written, since
 * a MODIFY over it would remap or reject rows. A ledger this server never created is skipped:
 * the additive pass makes it from `auditLogDdl`, which carries `changed` already.
 */
export const migration: Migration = {
  id: '0017_audit_records_a_change',
  description: "mica_audit_logs.action gains 'changed': a passcode or a join code replaced",
  up: async () => {
    const type = await Database.scalar<string | null>(
      `SELECT COLUMN_TYPE FROM information_schema.COLUMNS
        WHERE table_schema = DATABASE() AND table_name = 'mica_audit_logs' AND column_name = 'action'`,
      []
    );
    if (type === null || type === undefined) return;
    const values = enumValues(String(type));
    if (!values) {
      throw new Error(
        `mica_audit_logs.action is '${String(type)}', not an ENUM; change it by hand.`
      );
    }
    if (values.length === ACTIONS.length && values.every((v, i) => v === ACTIONS[i])) return;
    if (values.length > ACTIONS.length || values.some((v, i) => v !== ACTIONS[i])) {
      throw new Error(
        `mica_audit_logs.action holds (${values.join(', ')}), which is not the start of ` +
          `(${ACTIONS.join(', ')}); append the missing values by hand, in that order.`
      );
    }
    const list = ACTIONS.map((value) => `'${value}'`).join(', ');
    await Database.query(
      `ALTER TABLE \`mica_audit_logs\` MODIFY COLUMN \`action\` ENUM(${list}) NOT NULL`,
      []
    );
  }
};
