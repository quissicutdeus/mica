import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AppPermission } from './manifest';
import { bundledAddOns, registeredApps } from '../shell/state/registry';

/**
 * An app's declared permissions have to match what it actually reaches for.
 *
 * **This is not a sandbox, and cannot be one.** Every app runs in the same JS context as the
 * shell; an add-on that wanted `useContacts` without saying so could import it, or reach past
 * the SDK entirely. Nothing enforceable in the browser changes that, and §2.9 already says a
 * NUI request is not proof of intent — the server gates privileged actions independently and
 * remains the only real boundary.
 *
 * What this does buy is that the list is **true**. The Store shows a player which
 * capabilities an app wants, and until now that list was decorative: it was consumed by the
 * Store's renderer and by a made-up storage-size calculation, and by no hook at all. An app
 * declaring `permissions: []` had exactly the access of one declaring all seven, and half the
 * manifests understated what they touched — Settings declared nothing and used ten hooks.
 * A disclosure that nothing checks is worse than none, because players believe it.
 *
 * So: the code is the source of truth, and the manifest has to keep up with it.
 */

/**
 * Hooks whose use is a capability a player would want disclosed, and the permission that
 * discloses it.
 *
 * Deliberately narrow. Only hooks that touch player data or device hardware are here, because
 * those are what a permission means to the person reading it. `network` is absent on purpose:
 * every app talks to its own service over the NUI bridge, so deriving it from that would mark
 * all twelve and disclose nothing. It stays hand-declared. `location` used to be hand-declared
 * for the same reason — nothing inferred it — until `useLocation` gave it a real, specific hook.
 */
const REQUIRED_BY: Record<string, AppPermission> = {
  useContacts: 'contacts',
  useMedia: 'media',
  useCamera: 'camera',
  useLocation: 'location',
  usePhoneNotification: 'notifications',
  useStorage: 'storage',
  usePersisted: 'storage',
  /**
   * The cross-app half of storage, and the sharper one.
   *
   * `useStorage` reaches one namespace — the app's own. These two take an id, so they read and
   * delete anything any app has stored, which is more worth disclosing rather than less. They
   * were absent, so Settings' Apps pane could clear every app's data while declaring nothing.
   */
  appStorageBytes: 'storage',
  clearAppStorage: 'storage',
  /**
   * Both persist a preference through `usePersisted`, so they carry its disclosure. The
   * theme and the wallpaper are the phone's own appearance rather than anybody's data —
   * but an app that sets them writes to storage, and that is what `storage` says.
   */
  useTheme: 'storage',
  useWallpaper: 'storage'
};

const APPS_DIR = join(__dirname, '..', 'apps');

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.(svelte|ts)$/.test(entry) && !entry.endsWith('.test.ts') ? [full] : [];
  });

/**
 * What an app imports from `@gphone/sdk`, across every file it owns.
 *
 * Read from the import lists rather than by searching the text for hook names: a hook
 * mentioned in a comment is not a hook used, and to call one you must import it.
 */
const sdkImportsOf = (appId: string): Set<string> => {
  const names = new Set<string>();
  for (const file of walk(join(APPS_DIR, appId))) {
    const source = readFileSync(file, 'utf8');
    for (const [, list] of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'@gphone\/sdk'/g)) {
      for (const raw of list.split(',')) {
        const name = raw
          .replace(/^\s*type\s+/, '')
          .trim()
          .split(/\s+as\s+/)[0];
        if (name) names.add(name);
      }
    }
  }
  return names;
};

const APPS = [...registeredApps, ...bundledAddOns];

describe('declared permissions', () => {
  it('finds the apps to check', () => {
    expect(APPS.length).toBeGreaterThan(10);
  });

  it('covers every capability the app actually reaches for', () => {
    // Under-declaring is the lie that matters: the app touches a player's photos or contacts
    // and the Store says it does not.
    const understated = APPS.flatMap((app) => {
      const declared = new Set(app.permissions ?? []);
      const imported = sdkImportsOf(app.id);
      return [...imported]
        .filter((hook) => REQUIRED_BY[hook] && !declared.has(REQUIRED_BY[hook]))
        .map((hook) => `${app.id}: uses ${hook}, does not declare '${REQUIRED_BY[hook]}'`);
    });

    expect([...new Set(understated)].sort()).toEqual([]);
  });

  it('declares nothing that is not one of the seven', () => {
    // `defineApp` types this, but a remote manifest arrives as plain JSON and is not checked
    // by anything the compiler can see.
    const valid: AppPermission[] = [
      'notifications',
      'contacts',
      'camera',
      'media',
      'storage',
      'location',
      'network',
      'bluetooth'
    ];
    const unknown = APPS.flatMap((app) =>
      (app.permissions ?? []).filter((p) => !valid.includes(p)).map((p) => `${app.id}: '${p}'`)
    );

    expect(unknown).toEqual([]);
  });
});
