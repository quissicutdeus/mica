// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Migration } from '../lib/migrations';
import { Database } from '../lib/Database';

/**
 * MICA-432: the private columns that needed a schema change before they could be sealed.
 *
 * - **A blind index beside each sealed value something looks up or keeps unique** — a contact's
 *   number, a Dark Chat join code, a member's alias and handle — and the unique keys moved onto
 *   it. The value itself is still plaintext when this runs (nothing sealed these before), so each
 *   index is filled here in its no-key form, `plain:` and the value as it compares; with a key
 *   loaded, `micacrypt backfill --apply` then seals the values and re-indexes them under it.
 * - **A seal key on each table bound to its rows** (a Dark Chat channel, a thread), drawn here
 *   for every existing row.
 * - **A saved place's coordinates moved into one `position`**, as JSON, and `x`/`y`/`z` dropped.
 *   Plaintext until the backfill seals it, like every other value here.
 * - **`mica_contacts.avatar` retyped** from `mediumblob` to `mediumtext`: a sealed value is
 *   text. Its contents are base64, which reads the same in either.
 * - **Every newly sealed varchar widened** to what its plaintext bound needs once sealed.
 *
 * The widths and the generated keys are frozen as they shipped: a migration means what it ran,
 * whatever the declarations say later. Every step asks first and is skipped when done, so a run
 * that stopped part-way is finished by the next; a table that does not exist is skipped whole,
 * since `micaschema apply` creates missing tables only after its migrations (MICA-388).
 *
 * **The `plain:` fill is SQL's `LOWER` and trailing-space trim**, where the server's `aliasKey`
 * folds further (accents, ß to ss). The stored forms can differ — `plain:ghöst` beside the
 * server's `plain:ghost` — but never as a comparison sees them: the index columns are
 * `utf8mb4_unicode_ci`, which holds those two equal, in the unique key and in every lookup.
 * Under a key the backfill re-indexes with the server's own `aliasKey` all the same.
 */

const WIDTHS: readonly { table: string; column: string; width: number; nullable: boolean }[] = [
  { table: 'mica_contacts', column: 'phone', width: 166, nullable: false },
  { table: 'mica_messages_conversations', column: 'name', width: 326, nullable: true },
  { table: 'mica_darkchat', column: 'name', width: 230, nullable: false },
  { table: 'mica_darkchat', column: 'code', width: 102, nullable: false },
  { table: 'mica_darkchat_members', column: 'alias', width: 190, nullable: false },
  { table: 'mica_darkchat_members', column: 'handle', width: 146, nullable: false },
  { table: 'mica_invoices', column: 'from_label', width: 402, nullable: false },
  { table: 'mica_invoices', column: 'memo', width: 806, nullable: true },
  { table: 'mica_mail', column: 'sender', width: 594, nullable: false },
  { table: 'mica_mail', column: 'sender_address', width: 594, nullable: true },
  { table: 'mica_mail', column: 'subject', width: 1422, nullable: false }
];

const SEALED_PREFIX = '$mc1$';
const INDEX_WIDTH = 81;

const PHONE_KEY_DDL =
  "`phone_key` varchar(81) GENERATED ALWAYS AS (CASE WHEN `status` = 'active' THEN " +
  '`phone_index` ELSE NULL END) VIRTUAL';
const ALIAS_KEY_DDL =
  '`alias_key` varchar(81) GENERATED ALWAYS AS (CASE WHEN `left_at` IS NULL THEN ' +
  '`alias_index` ELSE NULL END) VIRTUAL';

/** A character set or collation name, as information_schema spells one, and nothing else. */
const CHARSET_NAME = /^[A-Za-z0-9_]+$/;
/** InnoDB keeps a one-byte length prefix below this many bytes, and a two-byte one from it. */
const TWO_BYTE_PREFIX = 256;

const count = async (sql: string, params: unknown[]): Promise<number> =>
  Number(await Database.scalar<number>(sql, params)) || 0;

const hasTable = async (table: string): Promise<boolean> =>
  (await count(
    'SELECT COUNT(*) FROM information_schema.TABLES WHERE table_schema = DATABASE() AND table_name = ?',
    [table]
  )) > 0;

const columnOf = async (
  table: string,
  column: string
): Promise<{
  type: string;
  chars: number;
  octets: number;
  charset: string;
  collation: string;
  generation: string;
} | null> => {
  const row = await Database.single<Record<string, unknown>>(
    `SELECT DATA_TYPE AS \`type\`, CHARACTER_MAXIMUM_LENGTH AS \`chars\`,
            CHARACTER_OCTET_LENGTH AS \`octets\`, CHARACTER_SET_NAME AS \`charset\`,
            COLLATION_NAME AS \`collation\`, GENERATION_EXPRESSION AS \`generation\`
       FROM information_schema.COLUMNS
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, column]
  );
  if (!row) return null;
  return {
    type: String(row.type ?? '').toLowerCase(),
    chars: Number(row.chars) || 0,
    octets: Number(row.octets) || 0,
    charset: String(row.charset ?? ''),
    collation: String(row.collation ?? ''),
    generation: String(row.generation ?? '')
  };
};

const hasIndex = async (table: string, index: string): Promise<boolean> =>
  (await count(
    'SELECT COUNT(*) FROM information_schema.STATISTICS WHERE table_schema = DATABASE() ' +
      'AND table_name = ? AND index_name = ?',
    [table, index]
  )) > 0;

const alter = async (table: string, change: string): Promise<void> => {
  await Database.query(`ALTER TABLE \`${table}\` ${change}`, []);
};

const addColumn = async (table: string, column: string, ddl: string): Promise<void> => {
  if (!(await columnOf(table, column))) await alter(table, `ADD COLUMN \`${column}\` ${ddl}`);
};

const dropIndex = async (table: string, index: string): Promise<void> => {
  if (await hasIndex(table, index)) await alter(table, `DROP INDEX \`${index}\``);
};

const restate = (table: string, column: string, charset: string, collation: string): void => {
  if (!CHARSET_NAME.test(charset) || !CHARSET_NAME.test(collation)) {
    throw new Error(
      `${table}.${column} reports character set '${charset}' and collation '${collation}', ` +
        'which this migration will not restate. Change it by hand, as the declaration says.'
    );
  }
};

/** Widen one varchar, in place where its length prefix allows and by a copy where not. */
const widen = async (
  table: string,
  column: string,
  width: number,
  nullable: boolean
): Promise<void> => {
  const current = await columnOf(table, column);
  if (!current || current.type !== 'varchar' || current.chars >= width) return;
  restate(table, column, current.charset, current.collation);
  const perChar = current.chars > 0 ? current.octets / current.chars : 4;
  const copy = current.octets < TWO_BYTE_PREFIX && width * perChar >= TWO_BYTE_PREFIX;
  if (copy) {
    console.log(
      `[micaschema] ${table}: copying the table to widen ${column} (MICA-432); its rows stay ` +
        'readable meanwhile, and writes to it wait until it is done.'
    );
  }
  await alter(
    table,
    `MODIFY COLUMN \`${column}\` varchar(${width}) CHARACTER SET ${current.charset} ` +
      `COLLATE ${current.collation} ${nullable ? 'DEFAULT NULL' : 'NOT NULL'}, ` +
      (copy ? 'ALGORITHM=COPY, LOCK=SHARED' : 'ALGORITHM=INPLACE, LOCK=NONE')
  );
};

/**
 * `, updated_at = updated_at` on a table that has one: a fill is not an edit, and the column's
 * `ON UPDATE` would otherwise stamp every row with the moment of the migration.
 */
const pin = async (table: string): Promise<string> =>
  (await columnOf(table, 'updated_at')) ? ', `updated_at` = `updated_at`' : '';

/** Draw a seal key for every row of `table` that has none: 32 hex characters, per row. */
const fillSealKeys = async (table: string): Promise<void> => {
  await addColumn(table, 'seal_key', 'varchar(32) DEFAULT NULL');
  await Database.query(
    `UPDATE \`${table}\` SET \`seal_key\` = MD5(CONCAT(UUID(), RAND(), \`id\`))${await pin(table)} ` +
      'WHERE `seal_key` IS NULL',
    []
  );
};

/** Fill an index column's no-key form for every plaintext value that has none yet. */
const fillPlainIndex = async (
  table: string,
  column: string,
  index: string,
  normalized: string
): Promise<void> => {
  // Right after the value, as the declarations emit it: the generated key reads it, and must be
  // defined after what it reads.
  await addColumn(table, index, `varchar(${INDEX_WIDTH}) DEFAULT NULL AFTER \`${column}\``);
  await Database.query(
    `UPDATE \`${table}\` SET \`${index}\` = CONCAT('plain:', ${normalized})${await pin(table)} ` +
      `WHERE \`${index}\` IS NULL AND \`${column}\` IS NOT NULL AND \`${column}\` NOT LIKE ?`,
    [`${SEALED_PREFIX}%`]
  );
};

/**
 * Point a generated unique key at the index, unless it already reads it: drop the unique key,
 * redefine the column, and put the key back on it.
 */
const rekey = async (
  table: string,
  key: { name: string; columns: string },
  column: string,
  ddl: string,
  reads: string
): Promise<void> => {
  const current = await columnOf(table, column);
  const keyed = await hasIndex(table, key.name);
  if (current?.generation.includes(reads) && keyed) return;
  /**
   * **One statement**, so there is no moment with no unique key: `micaschema apply` runs on a
   * live server, and a write between dropping the old key and adding the new one could land a
   * second live row the new key then refuses to be built over. MariaDB applies an `ALTER` whole
   * or not at all, so a run stopped here leaves the old key and column, and the next one redoes
   * it from the top.
   *
   * The column is dropped and added back rather than `MODIFY`'d: MariaDB recomputing a virtual
   * column whose expression changed in place was measured filling it with garbage bytes, refused
   * as an "Incorrect string value" (test:migrations). A virtual column holds nothing to lose.
   */
  await alter(
    table,
    [
      ...(keyed ? [`DROP KEY \`${key.name}\``] : []),
      ...(current ? [`DROP COLUMN \`${column}\``] : []),
      `ADD COLUMN ${ddl}`,
      `ADD UNIQUE KEY \`${key.name}\` (${key.columns})`
    ].join(', ')
  );
};

/**
 * Move a unique key from the plaintext column onto its index: the new key **before** the old one
 * goes, so a write never meets the table with neither. Each half asks first, so a run stopped
 * between them finishes on the next.
 */
const moveUnique = async (table: string, from: string, to: string): Promise<void> => {
  if (!(await hasIndex(table, to))) await alter(table, `ADD UNIQUE KEY \`${to}\` (\`${to}\`)`);
  await dropIndex(table, from);
};

const contacts = async (): Promise<void> => {
  const table = 'mica_contacts';
  if (!(await hasTable(table))) return;
  await fillPlainIndex(table, 'phone', 'phone_index', "LOWER(TRIM(TRAILING ' ' FROM `phone`))");
  await rekey(
    table,
    { name: 'device_phone_unique', columns: '`device_id`, `phone_key`' },
    'phone_key',
    PHONE_KEY_DDL,
    'phone_index'
  );
  await dropIndex(table, 'phone');
  await dropIndex(table, 'citizenid_phone');
  const avatar = await columnOf(table, 'avatar');
  if (avatar && avatar.type !== 'mediumtext') {
    const charset = (await columnOf(table, 'firstname'))?.charset || 'utf8mb4';
    const collation = (await columnOf(table, 'firstname'))?.collation || 'utf8mb4_unicode_ci';
    restate(table, 'avatar', charset, collation);
    await alter(
      table,
      `MODIFY COLUMN \`avatar\` mediumtext CHARACTER SET ${charset} COLLATE ${collation} ` +
        'DEFAULT NULL'
    );
  }
};

const darkchat = async (): Promise<void> => {
  const channels = 'mica_darkchat';
  if (await hasTable(channels)) {
    await fillSealKeys(channels);
    await fillPlainIndex(channels, 'code', 'code_index', '`code`');
    await moveUnique(channels, 'code', 'code_index');
  }
  const members = 'mica_darkchat_members';
  if (await hasTable(members)) {
    await fillPlainIndex(members, 'alias', 'alias_index', "LOWER(TRIM(TRAILING ' ' FROM `alias`))");
    await fillPlainIndex(members, 'handle', 'handle_index', '`handle`');
    await rekey(
      members,
      { name: 'channel_alias', columns: '`channel_id`, `alias_key`' },
      'alias_key',
      ALIAS_KEY_DDL,
      'alias_index'
    );
    await moveUnique(members, 'handle', 'handle_index');
  }
};

const conversations = async (): Promise<void> => {
  if (await hasTable('mica_messages_conversations')) {
    await fillSealKeys('mica_messages_conversations');
  }
};

const places = async (): Promise<void> => {
  const table = 'mica_places';
  if (!(await hasTable(table))) return;
  await addColumn(table, 'position', 'varchar(190) DEFAULT NULL');
  if (!(await columnOf(table, 'x'))) return;
  /**
   * As doubles: `JSON_OBJECT` over a `float` prints six significant digits, so -1037.2342 would
   * move as -1037.23 and 99999.99 as 100000 — a saved place shifted by metres. The cast carries
   * what the float actually holds. A row missing some of its coordinates keeps the ones it has,
   * JSON `null` for the rest, which the reader takes as no coordinate.
   */
  await Database.query(
    `UPDATE \`${table}\` SET \`position\` = JSON_OBJECT('x', CAST(\`x\` AS DOUBLE), ` +
      `'y', CAST(\`y\` AS DOUBLE), 'z', CAST(\`z\` AS DOUBLE))${await pin(table)} ` +
      'WHERE `position` IS NULL AND (`x` IS NOT NULL OR `y` IS NOT NULL OR `z` IS NOT NULL)',
    []
  );
  await alter(table, 'DROP COLUMN `x`, DROP COLUMN `y`, DROP COLUMN `z`');
};

export const migration: Migration = {
  id: '0014_private_lookups_get_blind_indexes',
  description:
    'blind indexes beside the sealed lookups (contacts, Dark Chat), seal keys for channels and ' +
    'threads, places.position for x/y/z, contacts.avatar as text, and the newly sealed ' +
    'columns widened',
  up: async () => {
    await contacts();
    await darkchat();
    await conversations();
    await places();
    for (const { table, column, width, nullable } of WIDTHS) {
      if (await hasTable(table)) await widen(table, column, width, nullable);
    }
  }
};
