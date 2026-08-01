import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import esbuild from 'esbuild';

/**
 * Emit one .sql file per defineServerApp declaration into sql/apps/.
 *
 * Nothing here touches a database. The generated files are reviewable artifacts you
 * apply yourself — see the note in server/lib/schemaSql.ts for why runtime
 * `CREATE TABLE IF NOT EXISTS` was rejected.
 *
 * Loading the declarations means executing server/ code in node, which touches FiveM
 * globals at import time (`Database` reads `exports.oxmysql`, ServerApp calls
 * `onNet`). The banner below stubs them, same as server/__tests__/setup.ts.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'sql', 'apps');

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
`;

const entry = `
import '${path.join(root, 'server/controllers/index.ts').split(path.sep).join('/')}';
export { declaredApps } from '${path.join(root, 'server/lib/defineServerApp.ts').split(path.sep).join('/')}';
export { toSqlFile } from '${path.join(root, 'server/lib/schemaSql.ts').split(path.sep).join('/')}';
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
 * Cross-app foreign keys make this necessary and alphabetical order wrong: the
 * messages app's attachment table references `gphone_photos`, and `messages` sorts
 * before `photos`, so a clean database fails with errno 150. Files are emitted with a
 * numeric prefix so that globbing or importing in name order is correct by default —
 * the failure mode this replaces was silent until a fresh install.
 *
 * Kahn's algorithm, alphabetical within a dependency level so output is stable.
 */
function orderAppsByDependency(apps) {
  const ownerOf = new Map();
  for (const app of apps) {
    ownerOf.set(app.table, app.id);
    for (const child of app.childTables) ownerOf.set(child.name, app.id);
  }

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
  const remaining = [...apps].sort((a, b) => a.id.localeCompare(b.id));

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

/** Wipe-and-rebuild in one file: drop everything, then the framework and app schemas. */
function buildResetSql(appFiles) {
  const frameworkSql = fs.readFileSync(path.join(root, 'gphone.sql'), 'utf8').trimEnd();

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

  const { declaredApps, toSqlFile } = await import(`file://${bundlePath}?t=${Date.now()}`);

  if (declaredApps.length === 0) {
    console.log('No defineServerApp declarations found; nothing to generate.');
    return;
  }

  fs.mkdirSync(outDir, { recursive: true });

  // Remove stale output so a renamed or reordered app cannot leave an orphan file
  // that someone would still import.
  for (const stale of fs.readdirSync(outDir).filter((f) => f.endsWith('.sql'))) {
    fs.unlinkSync(path.join(outDir, stale));
  }

  const ordered = orderAppsByDependency(declaredApps);
  const width = String(ordered.length).length;

  const appFiles = [];
  for (const [index, resolved] of ordered.entries()) {
    const sql = toSqlFile(resolved);
    const prefix = String(index + 1).padStart(width, '0');
    const name = `${prefix}-${resolved.id}.sql`;
    fs.writeFileSync(path.join(outDir, name), sql);
    appFiles.push({ id: resolved.id, sql });
    console.log(`Generated sql/apps/${name} (${resolved.table})`);
  }

  const tableCount = declaredApps.reduce((n, a) => n + 1 + a.childTables.length, 0);
  console.log(`Done. ${declaredApps.length} app(s), ${tableCount} table(s).`);

  if (withReset) {
    const resetPath = path.join(root, 'sql', 'dev-reset.sql');
    fs.writeFileSync(resetPath, buildResetSql(appFiles));
    console.log('');
    console.log('Also wrote sql/dev-reset.sql — DESTRUCTIVE.');
    console.log('  It drops every gphone_ table in the schema you connect it to,');
    console.log('  including the audit ledger, then recreates the whole schema.');
    console.log('  Dev only. Gitignored. Nothing here connects to a database.');
  }
}

main().catch((error) => {
  console.error('generate-sql failed:', error);
  process.exit(1);
});
