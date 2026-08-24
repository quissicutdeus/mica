import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import esbuild from 'esbuild';

/**
 * Emit the whole schema — every defineService declaration, in dependency order, plus the
 * framework tables nothing declares — as one gphone.sql.
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
const outFile = path.join(root, 'gphone.sql');

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
globalThis.GetCurrentResourceName = globalThis.GetCurrentResourceName ?? (() => 'gphone');
globalThis.RegisterCommand = globalThis.RegisterCommand ?? (() => {});
globalThis.IsPlayerAceAllowed = globalThis.IsPlayerAceAllowed ?? (() => false);
globalThis.GetConvar = globalThis.GetConvar ?? ((_n, fallback) => fallback);
`;

const entry = `
import '${path.join(root, 'server/services/index.ts').split(path.sep).join('/')}';
export { declaredServices } from '${path.join(root, 'server/lib/defineService.ts').split(path.sep).join('/')}';
export { toSqlFile, schemaMigrationsLedgerDdl, schemaMigrationsSeedSql } from '${path.join(root, 'server/lib/schemaSql.ts').split(path.sep).join('/')}';
`;

const bundlePath = path.join(root, 'node_modules', '.cache', 'gphone-sqlgen.mjs');

/**
 * The destructive half of `--with-reset`.
 *
 * Discovers `gphone_`-prefixed tables at apply time rather than listing the declared
 * ones, because the point of a reset is to clear tables whose declaration has since
 * been renamed or deleted — a static list cannot see those orphans.
 *
 * Safety properties, in order of how much they matter:
 *   - `table_schema = DATABASE()` confines it to the schema you are connected to.
 *   - `ESCAPE '|'` makes the underscore literal. Unescaped, `_` is a single-character
 *     LIKE wildcard, so `gphoneXfoo` would match too. A pipe is used rather than a
 *     backslash so nothing has to survive JS-template escaping on the way here.
 *   - `table_type = 'BASE TABLE'` leaves views alone.
 *   - `CHAR(96)` is a backtick, for the same escaping reason.
 *   - FK checks are suspended so drop order does not matter, then restored.
 */
const DROP_ALL_MICA_TABLES = [
  '-- Drop every gphone_ table in the CURRENT schema.',
  'SET FOREIGN_KEY_CHECKS = 0;',
  'SET SESSION group_concat_max_len = 1048576;',
  '',
  'SET @gphone_tables = NULL;',
  '',
  'SELECT GROUP_CONCAT(CONCAT(CHAR(96), table_name, CHAR(96)))',
  '  INTO @gphone_tables',
  '  FROM information_schema.tables',
  ' WHERE table_schema = DATABASE()',
  "   AND table_type = 'BASE TABLE'",
  "   AND table_name LIKE 'gphone|_%' ESCAPE '|';",
  '',
  'SET @gphone_drop = IF(',
  '  @gphone_tables IS NULL,',
  "  'DO 0', -- nothing matched; a valid no-op statement",
  "  CONCAT('DROP TABLE IF EXISTS ', @gphone_tables)",
  ');',
  '',
  'PREPARE gphone_drop_stmt FROM @gphone_drop;',
  'EXECUTE gphone_drop_stmt;',
  'DEALLOCATE PREPARE gphone_drop_stmt;',
  '',
  'SET FOREIGN_KEY_CHECKS = 1;'
].join('\n');

/**
 * Order apps so every table's foreign-key targets already exist when it is applied.
 *
 * Cross-app foreign keys make this necessary: nothing guarantees a table's dependencies
 * sort earlier than it does alphabetically, and a clean database fails with errno 150 the
 * moment one doesn't. Files are emitted with a numeric prefix so that globbing or
 * importing in name order is correct by default — the failure mode this replaces was
 * silent until a fresh install.
 *
 * Kahn's algorithm, alphabetical within a dependency level so output is stable.
 */
const referencedTables = (app) => {
  const refs = [];
  for (const { def } of app.fields) {
    if (def.references) refs.push(def.references.table);
  }
  for (const child of app.childTables) {
    for (const spec of Object.values(child.columns)) {
      const ref = typeof spec === 'string' ? undefined : spec.references;
      if (ref) refs.push(ref.table);
    }
  }
  return refs;
};

function orderAppsByDependency(apps) {
  const ownerOf = new Map();
  for (const app of apps) {
    ownerOf.set(app.table, app.id);
    for (const child of app.childTables) ownerOf.set(child.name, app.id);
  }

  // dependsOn: app id -> set of app ids that must be applied first.
  const dependsOn = new Map(apps.map((a) => [a.id, new Set()]));
  for (const app of apps) {
    for (const table of referencedTables(app)) {
      const owner = ownerOf.get(table);
      // Unowned targets are external (e.g. `players`) — not our problem to order.
      if (owner && owner !== app.id) dependsOn.get(app.id).add(owner);
    }
  }

  const ordered = [];
  const remaining = apps.toSorted((a, b) => a.id.localeCompare(b.id));

  while (remaining.length > 0) {
    const readyIndex = remaining.findIndex((app) =>
      [...dependsOn.get(app.id)].every((dep) => ordered.some((done) => done.id === dep))
    );

    if (readyIndex === -1) {
      const stuck = remaining.map((a) => a.id).join(', ');
      throw new Error(
        `generate-sql: circular foreign-key dependency between apps: ${stuck}. ` +
          'No apply order can satisfy these constraints.'
      );
    }
    ordered.push(...remaining.splice(readyIndex, 1));
  }

  return ordered;
}

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

/** Wipe-and-rebuild in one file: drop everything, then the framework and app schemas. */
function buildResetSql(appFiles, migrationsBlock) {
  const frameworkSql = fs
    .readFileSync(path.join(__dirname, 'framework-schema.sql'), 'utf8')
    .trimEnd();

  return [
    '-- ============================================================================',
    '-- DEVELOPMENT RESET — THIS DESTROYS ALL MICA DATA.',
    '--',
    '-- Drops every `gphone_`-prefixed table in the schema you are connected to,',
    '-- including the moderation audit ledger, then recreates the full schema.',
    '--',
    '-- Generated by `pnpm generate:sql --with-reset`. Never run this against a live',
    '-- server. It is gitignored on purpose: a committed "wipe everything" file is a',
    '-- footgun for anyone who clones the repo.',
    '-- ============================================================================',
    '',
    DROP_ALL_MICA_TABLES,
    '',
    '-- Framework schema (gphone.sql)',
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

  const { declaredServices, toSqlFile, schemaMigrationsLedgerDdl, schemaMigrationsSeedSql } =
    await import(`file://${bundlePath}?t=${Date.now()}`);

  if (declaredServices.length === 0) {
    console.log('No defineService declarations found; nothing to generate.');
    return;
  }

  const ordered = orderAppsByDependency(declaredServices);

  /**
   * One file, in dependency order.
   *
   * It used to be `gphone.sql` plus a numbered file per service in `sql/apps/`, imported
   * in filename order — because foreign keys cross app boundaries and alphabetical is
   * wrong. That worked, and it cost a rule every server owner had to be told, a prefix
   * that renumbered existing files whenever an app was added, and two places to look for
   * one schema. Concatenating in the same order it already computed removes all three:
   * the install is "import gphone.sql".
   *
   * The framework half — the moderation audit ledger — leads, and lives in
   * `scripts/framework-schema.sql` because it has no `defineService` behind it: no owning
   * module, and it does not fit the app-table shape (no `status`, no `updated_at`).
   */
  const frameworkSql = fs.readFileSync(path.join(__dirname, 'framework-schema.sql'), 'utf8');

  const appFiles = ordered.map((resolved) => ({ id: resolved.id, sql: toSqlFile(resolved) }));

  const banner = [
    '-- gPhone schema — the whole thing, in dependency order.',
    '--',
    '-- GENERATED by `pnpm generate:sql`. Do not edit by hand: every app table comes from',
    '-- its `defineService` declaration, which is the single source of truth. A second',
    '-- hand-maintained copy drifts, and the column allowlist that guards SQL identifier',
    '-- interpolation is only safe while it matches the real table.',
    '--',
    '-- Import this one file. The order inside it matters — foreign keys cross app',
    '-- boundaries — and it is already correct.',
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
      frameworkSql.trimEnd(),
      '',
      ...appFiles.map((f) => f.sql.trimEnd()),
      migrationsBlock
    ].join('\n\n') + '\n'
  );

  // The two tables no declaration owns, both emitted above: the moderation audit ledger
  // from framework-schema.sql, and the schema-migrations ledger.
  const UNDECLARED_TABLES = 2;
  const tableCount =
    declaredServices.reduce((n, a) => n + 1 + a.childTables.length, 0) + UNDECLARED_TABLES;
  console.log(
    `Generated gphone.sql — ${declaredServices.length} service(s), ${tableCount} table(s).`
  );

  if (withReset) {
    const resetPath = path.join(root, 'sql', 'dev-reset.sql');
    fs.writeFileSync(resetPath, buildResetSql(appFiles, migrationsBlock));
    console.log('');
    console.log('Also wrote sql/dev-reset.sql — DESTRUCTIVE.');
    console.log('  It drops every gphone_ table in the schema you connect it to,');
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
