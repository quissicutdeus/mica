// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import esbuild from 'esbuild';

/**
 * Emit the whole schema — every defineService declaration, in dependency order, plus the
 * framework tables nothing declares — as one mica.sql.
 *
 * Nothing here touches a database. The generated file is a reviewable artifact you
 * apply yourself — see the note in server/lib/schemaSql.ts for why runtime
 * `CREATE TABLE IF NOT EXISTS` was rejected for app tables.
 *
 * Loading the declarations means executing server/ code in node, which touches FiveM
 * globals at import time (`Database` reads `exports.oxmysql`, ServiceEndpoint calls
 * `onNet`). The banner below stubs them, same as server/__tests__/setup.ts.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const outFile = path.join(root, 'mica.sql');
/**
 * The same schema sized for `users.identifier` — see `esxBanner` in `main`.
 *
 * **Two audiences, one file, and the name stays `mica.esx.sql`.** It was written for ESX
 * (MICA-150) and standalone (MICA-151) needs exactly the same artifact for exactly the
 * same reason: neither has qb's `players` table. Renaming it to something framework-neutral
 * would break the link every ESX server owner already has, for a filename. The banner says who
 * it is for; the filename stays put.
 */
const esxOutFile = path.join(root, 'mica.esx.sql');

// Opt-in, because the artifact it produces destroys data.
const withReset = process.argv.includes('--with-reset');

// `exports` is dual-purpose in FiveM: indexed for other resources
// (exports['qbx_core']) and called to publish one (exports('Name', fn)). A function
// satisfies both, since a function is also an object.
const FIVEM_GLOBAL_STUBS = `
globalThis.exports = globalThis.exports ?? function () {};
globalThis.onNet = globalThis.onNet ?? (() => {});
globalThis.emitNet = globalThis.emitNet ?? (() => {});
globalThis.on = globalThis.on ?? (() => {});
globalThis.source = globalThis.source ?? 0;
globalThis.GetCurrentResourceName = globalThis.GetCurrentResourceName ?? (() => 'mica');
globalThis.RegisterCommand = globalThis.RegisterCommand ?? (() => {});
globalThis.IsPlayerAceAllowed = globalThis.IsPlayerAceAllowed ?? (() => false);
globalThis.GetConvar = globalThis.GetConvar ?? ((_n, fallback) => fallback);
`;

const entry = `
import '${path.join(root, 'server/services/index.ts').split(path.sep).join('/')}';
export { declaredServices } from '${path.join(root, 'server/lib/defineService.ts').split(path.sep).join('/')}';
export { toSqlFile, auditLogDdl, orderAppsByDependency, schemaMigrationsLedgerDdl, schemaMigrationsSeedSql, freshImportProbeSql } from '${path.join(root, 'server/lib/schemaSql.ts').split(path.sep).join('/')}';
`;

const bundlePath = path.join(root, 'node_modules', '.cache', 'mica-sqlgen.mjs');

/**
 * The destructive half of `--with-reset`.
 *
 * Discovers `mica_`-prefixed tables at apply time rather than listing the declared
 * ones, because the point of a reset is to clear tables whose declaration has since
 * been renamed or deleted — a static list cannot see those orphans.
 *
 * Safety properties, in order of how much they matter:
 *   - `table_schema = DATABASE()` confines it to the schema you are connected to.
 *   - `ESCAPE '|'` makes the underscore literal. Unescaped, `_` is a single-character
 *     LIKE wildcard, so `micaXfoo` would match too. A pipe is used rather than a
 *     backslash so nothing has to survive JS-template escaping on the way here.
 *   - `table_type = 'BASE TABLE'` leaves views alone.
 *   - `CHAR(96)` is a backtick, for the same escaping reason.
 *   - FK checks are suspended so drop order does not matter, then restored.
 */
const DROP_ALL_MICA_TABLES = [
  '-- Drop every mica_ table in the CURRENT schema.',
  'SET FOREIGN_KEY_CHECKS = 0;',
  'SET SESSION group_concat_max_len = 1048576;',
  '',
  'SET @mica_tables = NULL;',
  '',
  'SELECT GROUP_CONCAT(CONCAT(CHAR(96), table_name, CHAR(96)))',
  '  INTO @mica_tables',
  '  FROM information_schema.tables',
  ' WHERE table_schema = DATABASE()',
  "   AND table_type = 'BASE TABLE'",
  "   AND table_name LIKE 'mica|_%' ESCAPE '|';",
  '',
  'SET @mica_drop = IF(',
  '  @mica_tables IS NULL,',
  "  'DO 0', -- nothing matched; a valid no-op statement",
  "  CONCAT('DROP TABLE IF EXISTS ', @mica_tables)",
  ');',
  '',
  'PREPARE mica_drop_stmt FROM @mica_drop;',
  'EXECUTE mica_drop_stmt;',
  'DEALLOCATE PREPARE mica_drop_stmt;',
  '',
  'SET FOREIGN_KEY_CHECKS = 1;'
].join('\n');

/**
 * Same directory `generateMigrationsIndex` in generate-barrels.js reads — kept as an
 * independent scan rather than importing that barrel, so a stale generated barrel can't
 * hide a migration from the seed. server/__tests__/migrationsSeed.test.ts is the check that
 * the two agree.
 */
function migrationIds() {
  const dir = path.join(root, 'server', 'migrations');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith('.ts') && file !== 'index.ts' && !file.endsWith('.test.ts'))
    .map((file) => file.replace(/\.ts$/, ''))
    .toSorted();
}

/**
 * The first statement of `mica.sql`: fail the import on a server with no qb `players` table.
 *
 * The two files used to tell themselves apart for free — `mica.sql`'s foreign keys onto
 * `players` failed at the first `CREATE TABLE` on ESX. MICA-300 removed those keys, and
 * without this a wrong import would succeed quietly with every `citizenid` 50 wide, four short
 * of an es_extended multicharacter identifier (MICA-289), and the planner would only call it
 * drift. A read of `players` that returns nothing on qb and errors everywhere else keeps the
 * failure loud and first, naming the table. `mica.esx.sql` carries no such line.
 */
const QB_ONLY_GUARD = [
  '-- qb only: this fails with "Table ... players doesn\'t exist" on a server without qb.',
  '-- Import mica.esx.sql on es_extended or standalone instead.',
  'SELECT 1 FROM `players` LIMIT 0;'
].join('\n');

/**
 * The comment block that leads the audit log's table in both generated files.
 *
 * The statement itself is `auditLogDdl` in server/lib/schemaSql.ts, which the first-start
 * bootstrap runs too (MICA-306), so the two cannot describe different tables; a statement
 * carries no prose, and the prose an owner reading `mica.sql` sees lives here. It is the
 * comment block the hand-written `framework-schema.sql` carried until MICA-306 retired that
 * file, word for word, so the generated files did not change when it moved; the SPDX lines in
 * it are the ones they always carried.
 */
const AUDIT_LOG_HEADER = [
  '-- SPDX-FileCopyrightText: 2025 quissicutdeus',
  '--',
  '-- SPDX-License-Identifier: AGPL-3.0-or-later',
  '',
  '-- Central moderation and accountability ledger.',
  '--',
  '-- Every destructive or state-changing action a player takes on their own content is',
  '-- recorded here by `server/lib/AuditLogger.ts`: deletions, archives, leaving or being',
  '-- removed from a conversation, and moderation. It is append-only — nothing in micaOS',
  '-- updates or deletes a row in this table — so it stays a trustworthy record after the',
  '-- content it refers to has been soft-deleted.',
  '--',
  '-- One action, `viewed`, is not a player acting on their own content at all: it is an',
  '-- admin reading content somebody else reported (MICA-70). It is the one exception to',
  '-- "state-changing" above, and it exists for the same reason the rest of this table',
  '-- does — a read otherwise leaves nothing behind for anyone to be held accountable to.',
  '--',
  '-- `target_table` + `target_id` point at the affected row rather than using a foreign',
  '-- key, on purpose: the log must survive the row it describes, and it spans every app',
  '-- table. That is also why there is no FK on those columns.',
  '--',
  "-- Nor on `citizenid` (MICA-300). It used to reference qb's `players` with ON DELETE CASCADE,",
  "-- which deleted a character's rows inside MariaDB before any report hold could apply; the",
  '-- character-deleted purge and the orphan sweep (`server/lib/orphanSweep.ts`) clean up now.',
  '--',
  "-- `citizenid` is written at qb's width, `players.citizenid`'s 50. `pnpm generate:sql` widens",
  "-- it to 60, `users.identifier`'s, in mica.esx.sql (MICA-289), as it does every declared table."
].join('\n');

/** The audit log as a generated file carries it: its comment block, then the statement. */
const withAuditLogHeader = (ddl) => `${AUDIT_LOG_HEADER}\n${ddl}`;

/** Wipe-and-rebuild in one file: drop everything, then the framework and app schemas. */
function buildResetSql(frameworkSql, appFiles, migrationsBlock, freshImportProbe) {
  return [
    '-- ============================================================================',
    '-- DEVELOPMENT RESET — THIS DESTROYS ALL MICA DATA.',
    '--',
    '-- Drops every `mica_`-prefixed table in the schema you are connected to,',
    '-- including the moderation audit ledger, then recreates the full schema.',
    '--',
    '-- Generated by `pnpm generate:sql --with-reset`. Never run this against a live',
    '-- server. It is gitignored on purpose: a committed "wipe everything" file is a',
    '-- footgun for anyone who clones the repo.',
    '-- ============================================================================',
    '',
    DROP_ALL_MICA_TABLES,
    '',
    // After the drop, so the probe finds nothing and the seed below records every migration.
    freshImportProbe,
    '',
    '-- Framework schema (mica.sql)',
    frameworkSql,
    '',
    ...appFiles.flatMap(({ id, sql }) => [`-- App: ${id}`, sql.trimEnd(), '']),
    migrationsBlock,
    ''
  ].join('\n');
}

async function main() {
  fs.mkdirSync(path.dirname(bundlePath), { recursive: true });

  await esbuild.build({
    stdin: { contents: entry, resolveDir: root, loader: 'ts' },
    bundle: true,
    platform: 'node',
    format: 'esm',
    banner: { js: FIVEM_GLOBAL_STUBS },
    outfile: bundlePath,
    logLevel: 'warning'
  });

  const {
    declaredServices,
    toSqlFile,
    auditLogDdl,
    orderAppsByDependency,
    schemaMigrationsLedgerDdl,
    schemaMigrationsSeedSql,
    freshImportProbeSql
  } = await import(`file://${bundlePath}?t=${Date.now()}`);

  if (declaredServices.length === 0) {
    console.log('No defineService declarations found; nothing to generate.');
    return;
  }

  const ordered = orderAppsByDependency(declaredServices);

  /**
   * One file, in dependency order.
   *
   * It used to be `mica.sql` plus a numbered file per service in `sql/apps/`, imported
   * in filename order — because foreign keys cross app boundaries and alphabetical is
   * wrong. That worked, and it cost a rule every server owner had to be told, a prefix
   * that renumbered existing files whenever an app was added, and two places to look for
   * one schema. Concatenating in the same order it already computed removes all three:
   * the install is "import mica.sql".
   *
   * The framework half — the moderation audit ledger — leads. It has no `defineService`
   * behind it (no owning module, and it does not fit the app-table shape: no `status`, no
   * `updated_at`), so it is `auditLogDdl` in server/lib/schemaSql.ts, which the first-start
   * bootstrap runs as well (MICA-306).
   */
  const frameworkSql = withAuditLogHeader(auditLogDdl({ ownerTable: true }));
  const esxFrameworkSql = withAuditLogHeader(auditLogDdl({ ownerTable: false }));

  const appFiles = ordered.map((resolved) => ({ id: resolved.id, sql: toSqlFile(resolved) }));

  const banner = [
    '-- micaOS schema — the whole thing, in dependency order.',
    '--',
    '-- GENERATED by `pnpm generate:sql`. Do not edit by hand: every app table comes from',
    '-- its `defineService` declaration, which is the single source of truth. A second',
    '-- hand-maintained copy drifts, and the column allowlist that guards SQL identifier',
    '-- interpolation is only safe while it matches the real table.',
    '--',
    '-- Import this one file, on qbx_core or qb-core; es_extended and standalone take',
    '-- mica.esx.sql. The order inside it matters — foreign keys cross app boundaries —',
    '-- and it is already correct.',
    ''
  ].join('\n');

  /**
   * The ESX artifact (MICA-150).
   *
   * A second file rather than one conditional file, because the two differ in the width of
   * every `citizenid` column (MICA-289): qb's `players.citizenid` is 50, ESX's
   * `users.identifier` 60. Both come out of the same declarations in the same pass, so
   * neither can drift from the code or from each other.
   *
   * They used to differ in foreign keys as well: `mica.sql` hung every table off
   * `players(citizenid)` with `ON DELETE CASCADE`, which cannot import where qb is absent.
   * MICA-300 removed those keys from both — the cascade deleted held evidence before any hold
   * could apply — and `QB_ONLY_GUARD` keeps a wrong import failing at its first statement.
   */
  const esxAppFiles = ordered.map((resolved) => ({
    id: resolved.id,
    sql: toSqlFile(resolved, { ownerTable: false })
  }));

  const esxBanner = [
    '-- micaOS schema for ESX (`es_extended`) and for standalone — the whole thing, in',
    '-- dependency order.',
    '--',
    '-- GENERATED by `pnpm generate:sql`. Do not edit by hand. Same declarations as',
    '-- mica.sql, with one difference: every citizenid column is 60 wide, the width of',
    "-- ESX's users.identifier, where mica.sql's are qb's 50.",
    '--',
    '-- Import THIS file on es_extended or standalone, and mica.sql on qbx_core or',
    '-- qb-core. mica.sql refuses to import where there is no qb `players` table.',
    '--',
    '-- A deleted character leaves its rows behind until the character-deleted purge or the',
    '-- orphan sweep at resource start removes them, keeping what an open report holds. On',
    '-- standalone there is no character table to be deleted from, and micaOS is the only',
    '-- record a player has — which is also why the orphan sweep skips there.',
    ''
  ].join('\n');

  const ids = migrationIds();
  const seedSql = schemaMigrationsSeedSql(ids);
  const migrationsBlock = [
    '-- Versioned schema migrations ledger.',
    schemaMigrationsLedgerDdl(),
    ...(seedSql ? ['', seedSql] : [])
  ].join('\n');

  fs.writeFileSync(
    outFile,
    [
      banner,
      QB_ONLY_GUARD,
      freshImportProbeSql(),
      frameworkSql.trimEnd(),
      '',
      ...appFiles.map((f) => f.sql.trimEnd()),
      migrationsBlock
    ].join('\n\n') + '\n'
  );

  fs.writeFileSync(
    esxOutFile,
    [
      esxBanner,
      freshImportProbeSql(),
      esxFrameworkSql,
      '',
      ...esxAppFiles.map((f) => f.sql.trimEnd()),
      migrationsBlock
    ].join('\n\n') + '\n'
  );

  // The two tables no declaration owns, both emitted above: the moderation audit ledger
  // from `auditLogDdl`, and the schema-migrations ledger.
  const UNDECLARED_TABLES = 2;
  const tableCount =
    declaredServices.reduce((n, a) => n + 1 + a.childTables.length, 0) + UNDECLARED_TABLES;
  console.log(
    `Generated mica.sql — ${declaredServices.length} service(s), ${tableCount} table(s).`
  );

  if (withReset) {
    const resetPath = path.join(root, 'sql', 'dev-reset.sql');
    fs.mkdirSync(path.dirname(resetPath), { recursive: true });
    fs.writeFileSync(
      resetPath,
      buildResetSql(frameworkSql, appFiles, migrationsBlock, freshImportProbeSql())
    );
    console.log('');
    console.log('Also wrote sql/dev-reset.sql — DESTRUCTIVE.');
    console.log('  It drops every mica_ table in the schema you connect it to,');
    console.log('  including the audit ledger, then recreates the whole schema.');
    console.log('  Dev only. Gitignored. Nothing here connects to a database.');
  }
}

main()
  // Loading server/services/index.ts to read the declarations also runs it, and some
  // services (Battery) start a real setInterval as a side effect. A one-shot CLI script
  // has to exit itself rather than wait for an event loop those timers keep alive.
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('generate-sql failed:', error);
    process.exit(1);
  });
