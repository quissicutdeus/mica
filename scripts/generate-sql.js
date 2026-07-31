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
`;

const entry = `
import '${path.join(root, 'server/controllers/index.ts').split(path.sep).join('/')}';
export { declaredApps } from '${path.join(root, 'server/lib/defineServerApp.ts').split(path.sep).join('/')}';
export { toSqlFile } from '${path.join(root, 'server/lib/schemaSql.ts').split(path.sep).join('/')}';
`;

const bundlePath = path.join(root, 'node_modules', '.cache', 'gphone-sqlgen.mjs');

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

  for (const resolved of declaredApps) {
    const file = path.join(outDir, `${resolved.id}.sql`);
    fs.writeFileSync(file, toSqlFile(resolved));
    console.log(`Generated sql/apps/${resolved.id}.sql (${resolved.table})`);
  }

  console.log(`Done. ${declaredApps.length} table(s).`);
}

main().catch((error) => {
  console.error('generate-sql failed:', error);
  process.exit(1);
});
