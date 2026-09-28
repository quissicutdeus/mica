import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './support/test';

/**
 * MICA-295: an app that opts into the tablet (`devices: [..., 'tablet']` in its manifest)
 * is silently unswept the moment nothing under `e2e/tablet/` actually names it — the same
 * "no suite, no signal" failure AGENTS.md §8 describes for a missing NUI layer, pointed at
 * device coverage instead of a route. A reviewer reading the manifest sees a device
 * declared; nothing says the tablet root behind it was ever driven.
 *
 * The convention this holds new and existing tablet apps to: a tablet-capable app `<id>`
 * gets `e2e/tablet/<id>.spec.ts` — `admin.spec.ts`, `notes.spec.ts` and `settings.spec.ts`
 * today. A shell-level spec that is not about one app (`frame.spec.ts`, `launcher.spec.ts`,
 * `accessibility.spec.ts`) is not expected to carry one, and does not count as one either —
 * only a real per-app spec satisfies this, which is what keeps the guard honest rather than
 * satisfied by a file that happens to mention the id in a comment.
 *
 * Runs with no `page` fixture — pure filesystem, so it costs nothing next to the specs it
 * is guarding.
 */

const WEB = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const APPS_DIR = path.join(WEB, 'src/apps');
const TABLET_DIR = path.join(WEB, 'e2e/tablet');

/** Every app whose manifest opts into the tablet device. */
const tabletCapableApps = (): string[] =>
  fs
    .readdirSync(APPS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => {
      const manifestPath = path.join(APPS_DIR, entry.name, 'manifest.ts');
      if (!fs.existsSync(manifestPath)) return false;
      const manifest = fs.readFileSync(manifestPath, 'utf8');
      // Matches `devices: ['phone', 'tablet']` and `devices: ['tablet']`, in whatever
      // order and quoting the manifest wrote them.
      const devices = /devices:\s*\[([^\]]*)\]/.exec(manifest);
      if (!devices) return false;
      return /['"]tablet['"]/.test(devices[1]);
    })
    .map((entry) => entry.name);

test('every tablet-capable app has its own spec under e2e/tablet/', () => {
  const apps = tabletCapableApps();
  expect(apps.length, 'found at least one app that declares the tablet device').toBeGreaterThan(0);

  const specs = fs.readdirSync(TABLET_DIR).filter((name) => name.endsWith('.spec.ts'));
  const missing = apps.filter((id) => !specs.includes(`${id}.spec.ts`));

  expect(
    missing,
    `${missing.length} app(s) declare the tablet device but have no ` +
      `e2e/tablet/<id>.spec.ts of their own: ${missing.join(', ')}. Add one — this guard ` +
      'is what MICA-295 left in place of finding a gap like that by hand.'
  ).toEqual([]);
});
