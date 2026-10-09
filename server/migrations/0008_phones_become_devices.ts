// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Migration } from '../lib/migrations';
import { Database } from '../lib/Database';

const OLD_TABLE = 'mica_phones';
const NEW_TABLE = 'mica_devices';
const OLD_COLUMN = 'phone_id';
const NEW_COLUMN = 'device_id';

/** One key to rename: its old name, its new name, and the columns it is on after the rename. */
interface KeyRename {
  from: string;
  to: string;
  unique: boolean;
  columns: readonly string[];
}

/** The key `deviceOwned` injects on every device-owned table, named for its column. */
const COLUMN_KEY: KeyRename = {
  from: 'phone_id',
  to: 'device_id',
  unique: false,
  columns: ['device_id']
};
const ID_UNIQUE: KeyRename = {
  from: 'phone_id_unique',
  to: 'device_id_unique',
  unique: true,
  columns: ['device_id']
};

/**
 * Every table carrying a `phone_id` when this shipped, and every key on one that names it,
 * frozen: a migration means what it ran, whatever the declarations say later.
 */
const TABLES: readonly { table: string; keys: readonly KeyRename[] }[] = [
  { table: 'mica_battery', keys: [ID_UNIQUE, COLUMN_KEY] },
  {
    table: 'mica_blocklist',
    keys: [
      {
        from: 'phone_number_unique',
        to: 'device_number_unique',
        unique: true,
        columns: ['device_id', 'number']
      },
      COLUMN_KEY
    ]
  },
  { table: 'mica_contacts', keys: [COLUMN_KEY] },
  { table: NEW_TABLE, keys: [ID_UNIQUE] },
  { table: 'mica_lockscreen', keys: [ID_UNIQUE, COLUMN_KEY] },
  { table: 'mica_media', keys: [COLUMN_KEY] },
  {
    table: 'mica_messages_participants',
    keys: [
      {
        from: 'conversation_phone_unique',
        to: 'conversation_device_unique',
        unique: true,
        columns: ['conversation_id', 'device_id']
      },
      COLUMN_KEY
    ]
  },
  { table: 'mica_notes', keys: [COLUMN_KEY] },
  { table: 'mica_notifications', keys: [COLUMN_KEY] },
  { table: 'mica_phone_call_log', keys: [COLUMN_KEY] },
  { table: 'mica_phone_numbers', keys: [ID_UNIQUE] },
  { table: 'mica_places', keys: [COLUMN_KEY] },
  {
    table: 'mica_settings',
    keys: [
      {
        from: 'phone_app_key',
        to: 'device_app_key',
        unique: true,
        columns: ['device_id', 'app', 'setting_key']
      },
      COLUMN_KEY
    ]
  }
];

/** A character set or collation name, as information_schema spells one, and nothing else. */
const CHARSET_NAME = /^[A-Za-z0-9_]+$/;
/** A column type as information_schema spells this one: `varchar(32)`. */
const COLUMN_TYPE = /^varchar\(\d+\)$/i;

const hasTable = async (table: string): Promise<boolean> =>
  Number(
    await Database.scalar<number>(
      `SELECT COUNT(*) FROM information_schema.TABLES
        WHERE table_schema = DATABASE() AND table_name = ?`,
      [table]
    )
  ) > 0;

/** Migrations do not share code; these are copies on purpose, as 0001's are. */
const hasColumn = async (table: string, column: string): Promise<boolean> =>
  Number(
    await Database.scalar<number>(
      `SELECT COUNT(*) FROM information_schema.COLUMNS
        WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
      [table, column]
    )
  ) > 0;

const hasIndex = async (table: string, index: string): Promise<boolean> =>
  Number(
    await Database.scalar<number>(
      `SELECT COUNT(*) FROM information_schema.STATISTICS
        WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
      [table, index]
    )
  ) > 0;

const quote = (name: string): string => `\`${name}\``;

/**
 * `CHANGE COLUMN phone_id device_id …`, restating the column as it stands: its type, its
 * character set and collation, and whether it is nullable. `RENAME COLUMN` would not need any
 * of that, and needs MariaDB 10.5 or MySQL 8, which nothing here promises. Restated from the
 * column rather than the declaration so a rename is never also a retype or a re-collation.
 */
const renameColumn = async (table: string): Promise<string> => {
  const current = await Database.single<{
    type: string;
    nullable: string;
    charset: string | null;
    collation: string | null;
  }>(
    `SELECT COLUMN_TYPE AS \`type\`, IS_NULLABLE AS \`nullable\`,
            CHARACTER_SET_NAME AS \`charset\`, COLLATION_NAME AS \`collation\`
       FROM information_schema.COLUMNS
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, OLD_COLUMN]
  );
  if (!current) throw new Error(`${table}.${OLD_COLUMN} vanished while it was being renamed.`);
  const type = String(current.type);
  const charset = String(current.charset ?? '');
  const collation = String(current.collation ?? '');
  if (!COLUMN_TYPE.test(type) || !CHARSET_NAME.test(charset) || !CHARSET_NAME.test(collation)) {
    throw new Error(
      `${table}.${OLD_COLUMN} is ${type} in '${charset}'/'${collation}', which this migration ` +
        `will not restate. Rename it to ${NEW_COLUMN} by hand.`
    );
  }
  const nullable = String(current.nullable).toUpperCase() === 'YES';
  return (
    `CHANGE COLUMN ${quote(OLD_COLUMN)} ${quote(NEW_COLUMN)} ${type} ` +
    `CHARACTER SET ${charset} COLLATE ${collation} ${nullable ? 'DEFAULT NULL' : 'NOT NULL'}`
  );
};

/**
 * MICA-344: the device entity is named for any device. `mica_phones` becomes `mica_devices`,
 * and `phone_id` becomes `device_id` on every table that carries one, `mica_phone_numbers`
 * included, along with every key built on it. A tablet has been a row there since MICA-264,
 * and the old names said phone for both.
 *
 * **One `ALTER` per table**, the column and its keys together, so a table is either renamed
 * or untouched — never a renamed column under a key still named for the old one. A key is
 * dropped and re-added under its new name rather than `RENAME INDEX`ed, for the version reason
 * the column gives.
 *
 * **The table first, and refused rather than guessed when both names exist.** `mica.sql`
 * re-imported over a database from before this creates an empty `mica_devices` beside the
 * real `mica_phones` (every `CREATE` is `IF NOT EXISTS`); that empty table is dropped and the
 * real one renamed into its place. A `mica_devices` holding rows beside a `mica_phones` is
 * not a state this can resolve, and nor is a table carrying both `phone_id` and `device_id`:
 * both stop the migration with the names, for an operator to decide.
 *
 * The planner cannot do this: a rename is drift it reports and never touches. **Safe to run
 * twice** — every step asks `information_schema` first, so a second run finds nothing under an
 * old name — and a table this server never imported is skipped.
 */
export const migration: Migration = {
  id: '0008_phones_become_devices',
  description:
    'mica_phones becomes mica_devices, and phone_id becomes device_id on every table and key ' +
    'that names it',
  up: async () => {
    if (await hasTable(OLD_TABLE)) {
      if (await hasTable(NEW_TABLE)) {
        const rows = Number(
          await Database.scalar<number>(`SELECT COUNT(*) FROM ${quote(NEW_TABLE)}`, [])
        );
        if (rows > 0) {
          throw new Error(
            `Both ${OLD_TABLE} and ${NEW_TABLE} exist, and ${NEW_TABLE} holds ${rows} ` +
              `row${rows === 1 ? '' : 's'}. Nothing was renamed; decide which table is the ` +
              `real one and drop the other.`
          );
        }
        await Database.query(`DROP TABLE ${quote(NEW_TABLE)}`, []);
      }
      await Database.query(`RENAME TABLE ${quote(OLD_TABLE)} TO ${quote(NEW_TABLE)}`, []);
    }

    for (const { table, keys } of TABLES) {
      if (!(await hasTable(table))) continue;
      const changes: string[] = [];
      if (await hasColumn(table, OLD_COLUMN)) {
        if (await hasColumn(table, NEW_COLUMN)) {
          throw new Error(
            `${table} carries both ${OLD_COLUMN} and ${NEW_COLUMN}. Nothing on it was ` +
              `renamed; move what ${OLD_COLUMN} holds and drop it by hand.`
          );
        }
        changes.push(await renameColumn(table));
      }
      for (const key of keys) {
        if (!(await hasIndex(table, key.from))) continue;
        changes.push(`DROP KEY ${quote(key.from)}`);
        if (!(await hasIndex(table, key.to))) {
          changes.push(
            `ADD ${key.unique ? 'UNIQUE ' : ''}KEY ${quote(key.to)} ` +
              `(${key.columns.map(quote).join(', ')})`
          );
        }
      }
      if (changes.length > 0) {
        await Database.query(`ALTER TABLE ${quote(table)} ${changes.join(', ')}`, []);
      }
    }
  }
};
