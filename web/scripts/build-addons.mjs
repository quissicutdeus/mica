// MICA-16 step 4: runs `vite.addon.config.ts` once per add-on id instead of once for all
// of them.
//
// The config's `build.rollupOptions.output.codeSplitting = false` is what makes each
// bundle self-contained (one chunk, no shared vendor/runtime chunk a `data:`-loaded add-on
// could never import) — but on Vite 8's rolldown build path, `codeSplitting: false` rejects
// more than one `lib.entry` outright ("multiple inputs are not supported when
// output.codeSplitting is false"). The brief's fallback for exactly this case: build once
// per id, selected by `ADDON_ID`, rather than all four in one Rollup/rolldown invocation.
//
// Discovery mirrors `vite.addon.config.ts`'s own `addOnIds()` — the same manifest text
// `permissions.test.ts` reads — so the two never have to be kept in sync by hand; if this
// ever drifts, that's a bug to fix by extracting one shared function, not by hardcoding a
// list here. (Tried the shared-module route once already — `tsc -p tsconfig.node.json`
// rejected importing a plain `.mjs` from the `.ts` config with no declaration file for it;
// see `vite.addon.config.ts`'s comment on `addOnIds`.)
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn, spawnSync } from 'child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, '..');
const appsDir = path.join(webDir, 'src/apps');

function addOnIds() {
  return fs.readdirSync(appsDir).filter((id) => {
    const file = path.join(appsDir, id, 'manifest.ts');
    return fs.existsSync(file) && /core:\s*false/.test(fs.readFileSync(file, 'utf8'));
  });
}

const outDir = path.join(webDir, 'public/addons');
fs.rmSync(outDir, { recursive: true, force: true });

const watch = process.argv.includes('--watch');
const ids = addOnIds();

if (watch) {
  // One `vite build --watch` per id, all running concurrently — a single one blocks
  // forever, so the one-at-a-time loop below (right for a one-shot build) can't drive it.
  // `ADDON_WATCH=1` tells `vite.addon.config.ts` to skip minification so a dev rebuild
  // stays readable; `pnpm build`/`build:addons` (no watch) minify for real.
  const children = ids.map((id) =>
    spawn('vite', ['build', '-c', 'vite.addon.config.ts', '--watch'], {
      cwd: webDir,
      stdio: 'inherit',
      env: { ...process.env, ADDON_ID: id, ADDON_WATCH: '1' },
      shell: process.platform === 'win32'
    })
  );

  // Left running, these four `vite --watch` processes outlive this script's own event
  // loop (nothing else keeps it alive) and orphan themselves the moment the parent — the
  // `concurrently` process `pnpm dev` starts this under — is killed, since child_process
  // spawn doesn't propagate a parent's signal to its children by default. Forwarding each
  // signal, and on a plain `exit` too, is what actually stops them alongside `vite`
  // (the "shell" side `pnpm dev` also runs).
  const stopAll = () => {
    for (const child of children) child.kill();
  };
  process.once('SIGINT', () => {
    stopAll();
    process.exit(130);
  });
  process.once('SIGTERM', () => {
    stopAll();
    process.exit(143);
  });
  process.once('exit', stopAll);
} else {
  for (const id of ids) {
    const result = spawnSync('vite', ['build', '-c', 'vite.addon.config.ts'], {
      cwd: webDir,
      stdio: 'inherit',
      env: { ...process.env, ADDON_ID: id },
      shell: process.platform === 'win32'
    });
    // `spawnSync` reports a signal-terminated child via `.signal` with `.status: null`,
    // not a nonzero status — `result.status !== 0` still catches that (`null !== 0`), and
    // `?? 1` gives `process.exit` a real code instead of `null` for it.
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
