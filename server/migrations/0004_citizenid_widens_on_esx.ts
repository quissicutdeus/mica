// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Migration } from '../lib/migrations';
import { Database } from '../lib/Database';
import { ownerTableKnown } from '../lib/ownerWidth';

/** `users.identifier`'s width, frozen: the value `citizenIdWidth(false)` had when this shipped. */
const WIDTH = 60;

/**
 * Every column that held a citizenid when this shipped, frozen for the reason `0002` gives: a
 * migration means what it ran, whatever the declarations say later. The implicit `citizenid`
 * of every app table, the child tables' explicit ones, the two app columns that store another
 * character's citizenid, and the hand-written audit ledger. A table this server never
 * imported is skipped rather than failed.
 */
const COLUMNS: readonly (readonly [table: string, column: string])[] = [
  ['mica_audit_logs', 'citizenid'],
  ['mica_accounts', 'citizenid'],
  ['mica_battery', 'citizenid'],
  ['mica_blabber_dms', 'citizenid'],
  ['mica_blocklist', 'citizenid'],
  ['mica_contacts', 'citizenid'],
  ['mica_messages_conversations', 'citizenid'],
  ['mica_messages_participants', 'citizenid'],
  ['mica_highscores', 'citizenid'],
  ['mica_hodlr', 'citizenid'],
  ['mica_import_ledger', 'citizenid'],
  ['mica_invoices', 'citizenid'],
  ['mica_invoices', 'payee'],
  ['mica_lockscreen', 'citizenid'],
  ['mica_mail', 'citizenid'],
  ['mica_media', 'citizenid'],
  ['mica_blabber', 'citizenid'],
  ['mica_blabber_attachments', 'citizenid'],
  ['mica_marketplace', 'citizenid'],
  ['mica_marketplace_attachments', 'citizenid'],
  ['mica_messages', 'citizenid'],
  ['mica_messages_attachments', 'citizenid'],
  ['mica_messages_reactions', 'citizenid'],
  ['mica_notes', 'citizenid'],
  ['mica_notifications', 'citizenid'],
  ['mica_phone_call_log', 'citizenid'],
  ['mica_phone_numbers', 'citizenid'],
  ['mica_phones', 'citizenid'],
  ['mica_places', 'citizenid'],
  ['mica_reports', 'citizenid'],
  ['mica_reports', 'target_author'],
  ['mica_settings', 'citizenid']
];

interface LiveColumn {
  length: number;
  nullable: boolean;
  charset: string | null;
  collation: string | null;
}

const readColumn = async (table: string, column: string): Promise<LiveColumn | null> => {
  const row = await Database.single<{
    CHARACTER_MAXIMUM_LENGTH: number | string | null;
    IS_NULLABLE: string;
    CHARACTER_SET_NAME: string | null;
    COLLATION_NAME: string | null;
  }>(
    `SELECT CHARACTER_MAXIMUM_LENGTH, IS_NULLABLE, CHARACTER_SET_NAME, COLLATION_NAME
       FROM information_schema.COLUMNS
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, column]
  );
  if (!row) return null;
  return {
    length: Number(row.CHARACTER_MAXIMUM_LENGTH),
    nullable: row.IS_NULLABLE === 'YES',
    charset: row.CHARACTER_SET_NAME,
    collation: row.COLLATION_NAME
  };
};

const sqlName = (name: string | null): name is string =>
  typeof name === 'string' && /^[a-z0-9_]+$/i.test(name);

/**
 * Whether any micaOS table has a foreign key onto `players` — the qb file's shape.
 *
 * The second of two guards, not the decision: MariaDB refuses to MODIFY a column a foreign key
 * uses (ER 1832, even with `foreign_key_checks` off), and `players.citizenid` is 50 anyway, so
 * a database carrying these keys is never widened, whatever the framework says.
 */
const hasOwnerForeignKeys = async (): Promise<boolean> => {
  const count = await Database.scalar<number>(
    `SELECT COUNT(*) FROM information_schema.REFERENTIAL_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME = 'players'
        AND TABLE_NAME LIKE 'mica\\_%'`,
    []
  );
  return Number(count) > 0;
};

/**
 * MICA-289: on ESX and standalone a citizenid is `users.identifier`, a `varchar(60)`, and an
 * es_extended multicharacter identifier (`char1:license:<40 hex>`) is 54 — so every citizenid
 * column was 4 short of it, the identifier was refused, and that player had no phone.
 *
 * Widens each column to 60 where it is narrower, keeping its nullability, character set and
 * collation exactly as they are. A plain `MODIFY`: on this shape no foreign key uses these
 * columns.
 *
 * **Which server this is comes from the running framework** (`ownerWidth.ts`), the same
 * answer the planner judges drift by, so the two cannot disagree: qb is left at 50 even with
 * its foreign keys gone (MyISAM, or dropped by hand), and standalone — `mica.esx.sql`, but no
 * `users` table — is widened. Asking the database which owner table exists would get both
 * wrong, and an ESX box with a stray `players` table too. `micaschema apply` runs from the
 * console after boot, so the framework is known; if it is not, this refuses and stays pending
 * rather than guess, and the next apply picks it up.
 *
 * Widening cannot lose data, and every step asks `information_schema` first, so a run that
 * stops part-way resumes from the column it stopped at.
 */
export const migration: Migration = {
  id: '0004_citizenid_widens_on_esx',
  description:
    `widens every citizenid column to varchar(${WIDTH}), the width of ESX's users.identifier, ` +
    `on ESX and standalone; a qb server, or one whose tables carry players foreign keys, is untouched`,
  up: async () => {
    const ownerTable = ownerTableKnown();
    if (ownerTable === null) {
      throw new Error(
        'the framework has not been detected yet, so it is not known whether citizenid ' +
          'columns should be 50 (qb) or 60 (ESX, standalone). Run micaschema apply again ' +
          'once the server has finished starting.'
      );
    }
    if (ownerTable) {
      console.log('[mica] qb: citizenid columns follow players.citizenid (50); nothing to widen.');
      return;
    }
    if (await hasOwnerForeignKeys()) {
      console.warn(
        '[mica] this server runs without qb, but micaOS tables have foreign keys onto ' +
          'players — mica.sql was imported rather than mica.esx.sql. Nothing widened; those ' +
          'columns cannot be modified while the keys exist.'
      );
      return;
    }

    let widened = 0;
    for (const [table, column] of COLUMNS) {
      const live = await readColumn(table, column);
      if (!live || live.length >= WIDTH) continue;

      // Names from `information_schema`, not from anyone's input — but they are interpolated,
      // so anything that is not a plain charset or collation name is refused, not quoted.
      const charset = sqlName(live.charset) ? ` CHARACTER SET ${live.charset}` : '';
      const collation = sqlName(live.collation) ? ` COLLATE ${live.collation}` : '';
      const nullability = live.nullable ? 'DEFAULT NULL' : 'NOT NULL';
      await Database.query(
        `ALTER TABLE \`${table}\` MODIFY \`${column}\` varchar(${WIDTH})${charset}${collation} ${nullability}`,
        []
      );
      widened += 1;
    }
    console.log(`[mica] widened ${widened} citizenid column(s) to varchar(${WIDTH}).`);
  }
};
