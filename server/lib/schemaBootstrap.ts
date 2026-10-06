// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Database } from './Database';
import { ownerTableKnown } from './ownerWidth';
import {
  bootstrapTables,
  createStatements,
  freshDatabaseProbeSql,
  OWNER_TABLE,
  SCHEMA_MIGRATIONS_TABLE,
  shippedMigrationIds
} from './schemaSql';
import {
  installSchemaCheck,
  type SchemaOutcome,
  type SchemaRefusal,
  type SchemaShape
} from './schemaReady';

// The gate (`schemaReady()`, `whenSchemaReady`) and its outcome live in `schemaReady.ts`, which
// imports nothing, so the jobs it gates can wait on it without closing an import cycle through
// `schemaSql.ts` — see there. Re-exported for the two callers outside that cycle, which import
// this module and so also install the check.
export { whenSchemaReady } from './schemaReady';

/**
 * Create the schema on the first start of a fresh install, so no owner imports SQL by hand
 * (MICA-306).
 *
 * **Fresh** is `FRESH_DATABASE_PREDICATE`, the one `mica.sql` seeds its ledger by: no `mica_`
 * table at all. **Only then** does anything here write. A database with even one micaOS table
 * gets exactly what it had before: nothing at start, `micaschema` to report and `micaschema
 * apply`, from the console, to change it. That rule — micaOS changes no existing schema on its
 * own — is unchanged for every server that already has data.
 *
 * On a fresh database, the statements come from `createStatements`, the same declarations the
 * generated files are written from, run one at a time with plain `CREATE TABLE`, stopping at
 * the first error and never seeding after one. That boot is refused, with the steps that finish
 * it by hand. A create that stopped part-way is never resumed: the next start finds micaOS
 * tables, so the database is no longer fresh, and it says the database **may be half-created**
 * and leaves it alone (`checkExisting`), because the one thing worse than no schema is a guessed
 * one.
 *
 * Every message says only what was observed. A probe that could not read the database never
 * reports it empty, and a refusal says what micaOS did not do as well as why.
 */

/** The convar that turns this off, for owners whose database user has no DDL rights. */
export const AUTO_SCHEMA_CONVAR = 'mica_auto_schema';

/** Read like `mica_standalone`: a value that is neither is said once and read as off. */
const AUTO_SCHEMA_ON = new Set(['', '1', 'true', 'yes', 'on', 'enabled']);
const AUTO_SCHEMA_OFF = new Set(['0', 'false', 'no', 'off', 'disabled']);

/** How long to wait for the framework, or for another server's create, in one-second polls. */
const WAIT_POLLS = 60;
const POLL_MS = 1000;

const SHAPE_LABEL: Record<SchemaShape, string> = {
  qb: 'qbx/qb (citizenid 50 wide)',
  esx: 'ESX or standalone (citizenid 60 wide)'
};

const SHAPE_FILE: Record<SchemaShape, string> = { qb: 'mica.sql', esx: 'mica.esx.sql' };

const EITHER_FILE = 'mica.sql (qbx_core, qb-core) or mica.esx.sql (es_extended, standalone)';

const shapeOf = (ownerTable: boolean): SchemaShape => (ownerTable ? 'qb' : 'esx');

/** Said at the end of every refusal, so an owner knows what else is not happening. */
const JOBS_HELD =
  "micaOS's start-up jobs (schema reports, sweeps, retention, invoice expiry) do not run " +
  'until it is fixed and micaOS restarted.';

/** The way out of a half-created database, which no start of micaOS resumes. */
const finishByHand = (file: string): string =>
  `To finish it: import ${file} into this database (its CREATE TABLE IF NOT EXISTS creates ` +
  "only what is missing and records nothing), run 'micaschema apply' from the server console, " +
  'then restart micaOS.';

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
let sleep: (ms: number) => Promise<void> = realSleep;

/**
 * The driver's own words from a failed query.
 *
 * oxmysql's `*_async` exports reject with `new Error(output)`, where `output` is
 * "<resource> was unable to execute a query!", the whole query, and only then mysql2's message
 * on the last line — no `errno`, no `code`. The last line is the part worth logging, and the
 * only part safe to classify: the query text above it is ours.
 */
const driverMessage = (error: unknown): string => {
  const text = error instanceof Error ? error.message : String(error);
  if (!/unable to execute a query!/.test(text)) return text;
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  return lines[lines.length - 1] ?? text;
};

/**
 * The MySQL errno of a failure, from `errno` where the error carries one (mysql2 in-process, as
 * `test:schema` runs it) and from the message where it does not (oxmysql across a resource
 * boundary, which carries only text). Null for anything else.
 */
export const driverErrno = (error: unknown): number | null => {
  if (error && typeof error === 'object') {
    const { errno, code } = error as { errno?: unknown; code?: unknown };
    if (typeof errno === 'number') return errno;
    if (code === 'ER_TABLE_EXISTS_ERROR') return 1050;
    if (code === 'ER_TABLEACCESS_DENIED_ERROR') return 1142;
  }
  const message = driverMessage(error);
  if (/^Table '[^']+' already exists$/i.test(message.trim())) return 1050;
  if (/\bcommand denied to user\b/i.test(message)) return 1142;
  return null;
};

/** `mica_auto_schema`: on unless an owner turned it off. */
const autoSchemaEnabled = (): boolean => {
  let raw: string;
  try {
    raw = typeof GetConvar === 'function' ? String(GetConvar(AUTO_SCHEMA_CONVAR, '1')) : '1';
  } catch {
    return true;
  }
  const value = raw.trim().toLowerCase();
  if (AUTO_SCHEMA_ON.has(value)) return true;
  if (AUTO_SCHEMA_OFF.has(value)) return false;
  console.warn(
    `[mica] ${AUTO_SCHEMA_CONVAR} is set to '${raw}', which is neither on nor off. Reading it ` +
      "as off, so micaOS will not create a fresh database's schema. Set it to '1' or '0'."
  );
  return false;
};

/** Every `mica_` table in the connected schema. Throws when it cannot be read. */
const liveMicaTables = async (): Promise<Set<string>> => {
  const rows = await Database.query<{ name?: unknown }[]>(
    'SELECT table_name AS `name` FROM information_schema.TABLES ' +
      "WHERE table_schema = DATABASE() AND table_name LIKE 'mica|_%' ESCAPE '|'",
    []
  );
  if (!Array.isArray(rows)) throw new Error('information_schema.TABLES answered no rows');
  return new Set(rows.map((row) => String(row?.name)));
};

const ledgerRowCount = async (): Promise<number> =>
  Number(await Database.scalar(`SELECT COUNT(*) FROM \`${SCHEMA_MIGRATIONS_TABLE}\``, []));

const refuse = (reason: SchemaRefusal, message: string): SchemaOutcome => {
  console.error(message);
  return { kind: 'refused', reason, message };
};

/**
 * Not fresh, so never refused and never touched: always `existing`. One reading is worth saying
 * out loud first — a database that **may be half-created**.
 *
 * That is the migrations ledger existing, holding no id, beside a missing table the bootstrap
 * would create: what a first start that stopped part-way leaves, since the ledger is its first
 * statement and the seed its last. But it is also what an existing install looks like after it
 * re-imported `mica.sql` over an older database (which creates the ledger and, since MICA-301,
 * records nothing) and then took an update that added a table. Refusing would stop that live
 * server's start-up jobs on every boot until its owner acted, so this says what it sees, with
 * the way to finish it, and lets start-up run exactly as it did before MICA-306. The missing
 * tables then surface through the jobs' own errors and `micaschema`'s report, as they always did.
 */
const checkExisting = async (): Promise<SchemaOutcome> => {
  let present: Set<string>;
  let recorded: number;
  try {
    present = await liveMicaTables();
    if (!present.has(SCHEMA_MIGRATIONS_TABLE)) return { kind: 'existing' };
    recorded = await ledgerRowCount();
  } catch (error) {
    // The probe already answered "not fresh", so this changes nothing either way; an existing
    // database is left to the reports that run next, which say what they cannot read.
    console.warn(
      `[mica] could not check whether this database's schema is complete (${driverMessage(error)}).`
    );
    return { kind: 'existing' };
  }
  if (recorded > 0) return { kind: 'existing' };

  const missing = bootstrapTables().filter((table) => !present.has(table));
  if (missing.length === 0) return { kind: 'existing' };

  const shown = missing.slice(0, 5).join(', ') + (missing.length > 5 ? ', …' : '');
  const known = ownerTableKnown();
  const file = known === null ? EITHER_FILE : SHAPE_FILE[shapeOf(known)];
  console.error(
    `[mica] this database may be half-created: ${SCHEMA_MIGRATIONS_TABLE} exists with no ` +
      `migration recorded, and ${missing.length} table(s) micaOS needs are missing (${shown}). ` +
      'That is what a first-start create that stopped part-way leaves, or an existing install ' +
      'that re-imported mica.sql and has since gained a table; micaOS creates nothing in a ' +
      'database that already has its tables. (If another server sharing this database is ' +
      'creating it right now, restart this one once that server has started.) ' +
      finishByHand(file)
  );
  return { kind: 'existing' };
};

/** Wait for the framework to say which schema this is, about a minute at most. */
const awaitOwnerTable = async (): Promise<boolean | null> => {
  for (let poll = 0; ; poll++) {
    const known = ownerTableKnown();
    if (known !== null || poll >= WAIT_POLLS) return known;
    await sleep(POLL_MS);
  }
};

/** Another server took the ledger. Wait for its seed, which it writes last. */
const awaitOtherServer = async (file: string): Promise<SchemaOutcome> => {
  const tables = bootstrapTables();
  const seeded = shippedMigrationIds().length > 0;
  for (let poll = 0; poll < WAIT_POLLS; poll++) {
    await sleep(POLL_MS);
    try {
      const present = await liveMicaTables();
      if (!tables.every((table) => present.has(table))) continue;
      if (!seeded || (await ledgerRowCount()) > 0) {
        console.log(
          '[mica] another server sharing this database created the schema while this one ' +
            'waited; using it.'
        );
        return { kind: 'created-elsewhere' };
      }
    } catch {
      // Unreadable for a moment is not an answer; keep waiting until the time is up.
    }
  }
  return refuse(
    'concurrent-create',
    `[mica] another server is creating micaOS's schema in this database: ` +
      `${SCHEMA_MIGRATIONS_TABLE} appeared after this one found the database empty, and its ` +
      `seed did not follow within ${WAIT_POLLS}s, so micaOS created nothing. If that server's ` +
      'create stopped part-way, this database is half-created. ' +
      `${finishByHand(file)} ${JOBS_HELD}`
  );
};

/** A database with no micaOS table: create it, or say exactly why not. */
const createFresh = async (): Promise<SchemaOutcome> => {
  if (!autoSchemaEnabled()) {
    const known = ownerTableKnown();
    const file = known === null ? EITHER_FILE : SHAPE_FILE[shapeOf(known)];
    return refuse(
      'disabled',
      `[mica] this database holds no micaOS table, and ${AUTO_SCHEMA_CONVAR} is off, so ` +
        `micaOS created nothing. Import ${file} into it, then restart micaOS. ${JOBS_HELD}`
    );
  }

  const ownerTable = await awaitOwnerTable();
  if (ownerTable === null) {
    return refuse(
      'framework-unknown',
      '[mica] this database holds no micaOS table, but no framework answered within ' +
        `${WAIT_POLLS}s, so micaOS cannot tell which schema to create (citizenid is 50 wide on ` +
        'qbx/qb, 60 on ESX and standalone) and created nothing. Ensure qbx_core, qb-core or ' +
        "es_extended above micaOS in server.cfg, or set 'mica_standalone 1' for no framework, " +
        `then restart micaOS — or import ${EITHER_FILE} by hand. ${JOBS_HELD}`
    );
  }

  const shape = shapeOf(ownerTable);
  const file = SHAPE_FILE[shape];

  if (ownerTable) {
    try {
      await Database.query(`SELECT 1 FROM \`${OWNER_TABLE}\` LIMIT 0`, []);
    } catch (error) {
      return refuse(
        'owner-table-missing',
        `[mica] this is a qbx/qb server, but its \`${OWNER_TABLE}\` table could not be read ` +
          `(${driverMessage(error)}), so micaOS created nothing. Start qbx_core or qb-core, ` +
          `and let it create \`${OWNER_TABLE}\`, before micaOS; then restart micaOS. ${JOBS_HELD}`
      );
    }
  }

  const statements = createStatements(ownerTable);
  const tables = bootstrapTables();
  const total = statements.length;
  console.log(
    `[mica] this database holds no micaOS table: creating the schema for ${SHAPE_LABEL[shape]}, ` +
      `${total} statement(s).`
  );

  for (let i = 0; i < total; i++) {
    try {
      await Database.query(statements[i], []);
    } catch (error) {
      const what = i < tables.length ? tables[i] : 'the migrations ledger seed';
      const detail = driverMessage(error);
      const errno = driverErrno(error);
      console.error(
        `[mica] creating ${what} failed (statement ${i + 1} of ${total}): ${detail}. Stopped ` +
          'there; the migrations ledger was not seeded.'
      );

      if (i === 0 && errno === 1050) return awaitOtherServer(file);

      const after =
        i === 0
          ? 'Nothing was created.'
          : `${i} of ${total} statement(s) ran first, so this database is now half-created. ` +
            finishByHand(file);

      if (errno === 1142) {
        return refuse(
          'no-ddl-rights',
          `[mica] the database user may not create micaOS's tables (${detail}). Grant it ` +
            `CREATE, INDEX and REFERENCES on this database, or set '${AUTO_SCHEMA_CONVAR} 0' ` +
            `and import ${file} by hand. ${after} ${JOBS_HELD}`
        );
      }
      return refuse(
        'create-failed',
        `[mica] creating micaOS's schema stopped at ${what} (statement ${i + 1} of ${total}): ` +
          `${detail}. ${after} ${JOBS_HELD}`
      );
    }
  }

  console.log(
    `[mica] created micaOS's schema for ${SHAPE_LABEL[shape]}: ${tables.length} tables, ` +
      `${shippedMigrationIds().length} migration(s) recorded as applied.`
  );
  return { kind: 'created', shape, tables: tables.length };
};

const bootstrap = async (): Promise<SchemaOutcome> => {
  let answer: unknown;
  try {
    answer = await Database.scalar(freshDatabaseProbeSql(), []);
  } catch (error) {
    const detail = driverMessage(error);
    console.error(
      `[mica] could not tell whether this database already holds micaOS's tables (${detail}), ` +
        'so micaOS created nothing. If it is a fresh install, fix the connection and restart ' +
        `micaOS, or import ${EITHER_FILE} by hand.`
    );
    return { kind: 'unknown', error: detail };
  }

  // 1 or 0, from `COUNT(*) = 0`; a driver may hand either back as a number or a string.
  const fresh = answer === null || answer === undefined ? Number.NaN : Number(answer);
  if (fresh === 0) return checkExisting();
  if (fresh === 1) return createFresh();

  console.error(
    `[mica] could not tell whether this database already holds micaOS's tables (the probe ` +
      `answered ${String(answer)}), so micaOS created nothing.`
  );
  return { kind: 'unknown', error: `the probe answered ${String(answer)}` };
};

/**
 * The check `schemaReady()` runs, exported for its own tests. Everything else goes through
 * `schemaReady()`, which runs it once per resource start.
 */
export const runSchemaBootstrap = bootstrap;

// Filled at import. `services/Schema.ts` imports this module, so the resource always has it.
installSchemaCheck(bootstrap);

/** Test seam: replace the one-second wait between polls; `null` restores the real one. */
export const __setSchemaSleepForTests = (fn: ((ms: number) => Promise<void>) | null): void => {
  sleep = fn ?? realSleep;
};
