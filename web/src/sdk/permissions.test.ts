import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ALL_PERMISSIONS } from './manifest';
import { HOOK_OF_FACET, PERMISSION_OF, permissionOfFacet } from './permissions';
import { bundledAddOns, registeredApps } from '../shell/state/registry';

/**
 * An app's declared permissions have to match what it actually reaches for.
 *
 * **A `core: true` app is still not sandboxed from the shell.** It runs in the shell's own JS
 * context; an app that wanted `useContacts` without saying so could import it, or reach past
 * the SDK entirely. A `core: false` add-on is different since `MICA-16` Step 4 — it runs in
 * a sandboxed iframe and the shell re-checks every permission before answering a call — but
 * §2.9 still applies either way: a NUI request is not proof of intent, and the server gates
 * privileged actions independently.
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
    const understated = APPS.flatMap((app) => {
      const declared = new Set(app.permissions ?? []);
      const imported = sdkImportsOf(app.id);
      return [...imported].flatMap((name) => {
        const row = PERMISSION_OF[name];
        if (!row) return [];
        const perms = Array.isArray(row) ? row : [row];
        return perms
          .filter((p) => !declared.has(p))
          .map((p) => `${app.id}: uses ${name}, does not declare '${p}'`);
      });
    });
    expect([...new Set(understated)].sort()).toEqual([]);
  });

  it('declares only names in the vocabulary', () => {
    const unknown = APPS.flatMap((app) =>
      (app.permissions ?? [])
        .filter((p) => !ALL_PERMISSIONS.includes(p))
        .map((p) => `${app.id}: '${p}'`)
    );
    expect(unknown).toEqual([]);
  });
});

describe('the permission table is total', () => {
  const HOST = join(__dirname, 'host');
  const hostFiles = readdirSync(HOST).filter(
    (f) => /^use[A-Z].*\.ts$/.test(f) && !f.endsWith('.test.ts')
  );
  const hookNames = hostFiles.map((f) => f.replace(/\.svelte\.ts$|\.ts$/, ''));

  // Every non-test .ts file under sdk/host, read once. `assertCapability`'s row for a
  // symbol is not necessarily in the file named after it — `useStorage.ts` alone defines
  // `useStorage`, `appStorageBytes` and `clearAppStorage` — so the table's coverage has to
  // be proved per *export*, not per *file*. The earlier version of this test iterated
  // `hostFiles` and so only ever looked at hooks whose file is named after them; it went
  // green on `appStorageBytes`/`clearAppStorage` never asserting, because nothing looked.
  const hostSourceFiles = readdirSync(HOST).filter(
    (f) => f.endsWith('.ts') && !f.endsWith('.test.ts')
  );
  const hostSources = hostSourceFiles.map((file) => ({
    file,
    text: readFileSync(join(HOST, file), 'utf8')
  }));

  // Rows with no host-side symbol of their own — their disclosure comes from something
  // else entirely, not from an `assertCapability`/`guarded()` call under their own name.
  // They stay in `PERMISSION_OF` for `sdkImportsOf`/manifest checking above (or, for
  // `lifecycle`, for `permissionOfFacet` to resolve at all), but have nothing to locate
  // here.
  //
  // - `PhotoPickerModal`/`ReportDialog` (`sdk/ui`, not `sdk/host`): disclosed via the host
  //   hook they call internally.
  // - `lifecycle` (MICA-27): no public hook at all, by design — it is the implicit,
  //   no-permission plumbing `onAppForeground`, `useDeepLink`, `onback`, and
  //   `useAppLevels`'s Back binding are each built out of, and each of *those* already
  //   goes through its own `guarded()` call under its own name. A `lifecycle` wrapper
  //   here would just be a second, redundant gate on the same capability.
  const DISCLOSED_ELSEWHERE = new Set(['PhotoPickerModal', 'ReportDialog', 'lifecycle']);

  /**
   * Find where `name` is exported from `sdk/host`, and the slice of source from that
   * export up to (but not including) the next top-level `export`. Bounding the slice
   * matters: `useStorage.ts` defines three exports, and an unbounded search for
   * `assertCapability` after `export function clearAppStorage` would happily match the
   * call inside `useStorage`, two exports later, and call `clearAppStorage` covered when
   * it is not.
   */
  const findDefinition = (name: string): { file: string; body: string } | undefined => {
    const re = new RegExp(String.raw`export (?:function|const) ${name}\b`);
    for (const { file, text } of hostSources) {
      const match = re.exec(text);
      if (!match) continue;
      const afterStart = match.index + match[0].length;
      const nextExport = text.slice(afterStart).search(/\n\s*export /);
      const body =
        nextExport === -1
          ? text.slice(match.index)
          : text.slice(match.index, afterStart + nextExport);
      return { file, body };
    }
    return undefined;
  };

  it('every host hook has a row', () => {
    const missing = hookNames.filter((name) => !(name in PERMISSION_OF));
    expect(missing, 'add it to sdk/permissions.ts').toEqual([]);
  });

  it('every non-kit row names a symbol that is actually exported from sdk/host', () => {
    const stale = Object.keys(PERMISSION_OF)
      .filter((name) => !DISCLOSED_ELSEWHERE.has(name))
      .filter((name) => !findDefinition(name))
      .map((name) => `${name}: no export found under sdk/host`);
    expect(stale, 'remove it from sdk/permissions.ts, or fix the name').toEqual([]);
  });

  it('every hook, implicit rows included, goes through guarded() with its own name', () => {
    // The host protocol (MICA-16 step 3) is what turns a declared permission into a
    // refusal now — `guard.ts` looks `hookName` up in `PERMISSION_OF` itself and throws
    // `AppPermissionError` when it is missing. So the per-hook check that mattered when
    // `assertCapability` took the permission literal directly is now: does this hook's own
    // body actually call `guarded('<its own name>')` rather than skip the gate (call its
    // facet directly, or call `guarded` with a different hook's name by copy-paste)?
    const wrong: string[] = [];
    for (const [name, expected] of Object.entries(PERMISSION_OF)) {
      // implicit (null) rows still resolve through guarded() — they just carry no
      // permission to check — so they are covered here too, not skipped.
      if (DISCLOSED_ELSEWHERE.has(name)) continue;
      if (Array.isArray(expected)) {
        wrong.push(`${name}: row is an array but a host hook must gate exactly one name`);
        continue;
      }
      const def = findDefinition(name);
      if (!def) {
        wrong.push(`${name}: no export found under sdk/host`);
        continue;
      }
      const call = def.body.match(/guarded\(\s*'([a-zA-Z]+)'/);
      if (!call) wrong.push(`${name}: no guarded() call`);
      else if (call[1] !== name)
        wrong.push(`${name}: guarded('${call[1]}'), expected guarded('${name}')`);
    }
    expect(wrong).toEqual([]);
  });
});

describe('HOOK_OF_FACET', () => {
  it('names a hook for every facet, and that hook exists in PERMISSION_OF', () => {
    // The Facets interface is type-only; read the facet names from the facets directory.
    const dir = join(__dirname, 'host/inProcess/facets');
    const names = readdirSync(dir)
      .filter((f) => f !== 'index.ts' && f.endsWith('.ts'))
      .map((f) => f.replace(/\.svelte\.ts$|\.ts$/, ''));
    // storage.ts exports three facets; lifecycle.ts exports three (MICA-27 added
    // `lifecycle` itself alongside onAppForeground/onAppUnmount).
    const expected = new Set([
      ...names.filter((n) => !['storage', 'lifecycle'].includes(n)),
      'storage',
      'appStorageBytes',
      'clearAppStorage',
      'onAppForeground',
      'onAppUnmount',
      'lifecycle'
    ]);
    expect(new Set(Object.keys(HOOK_OF_FACET))).toEqual(expected);
    for (const hook of Object.values(HOOK_OF_FACET)) expect(hook in PERMISSION_OF).toBe(true);
  });

  it('permissionOfFacet resolves through the table', () => {
    expect(permissionOfFacet('contacts')).toEqual({ hook: 'useContacts', needed: 'contacts' });
    expect(permissionOfFacet('nope')).toBeUndefined();
  });
});

describe("useService stays in the app's own namespace", () => {
  /**
   * `useService(id)` is the generic door to a server service, and the id is the caller's
   * to choose — which made it the second hatch: nothing stopped `useService('contacts')`.
   * An app's services are its own id and anything under `<id>_` (Blabber's `blabber_dms`).
   * Enforced by reading the source, because the hook is called from stores outside
   * component init where there is no context to read the app id from; the runtime half of
   * this rule arrives with the host protocol (MICA-16, step 3). A non-literal argument is
   * refused too — a computed id is an id this test cannot see.
   */
  const CALL = /useService\(\s*([^)]*?)\s*\)/g;
  const LITERAL = /^['"]([a-z0-9_]+)['"]$/;

  it('every app calls useService with a literal id in its own namespace', () => {
    const offenders: string[] = [];
    for (const app of APPS) {
      for (const file of walk(join(APPS_DIR, app.id))) {
        const source = readFileSync(file, 'utf8');
        for (const [, arg] of source.matchAll(CALL)) {
          const literal = arg.match(LITERAL)?.[1];
          const ok =
            literal !== undefined && (literal === app.id || literal.startsWith(`${app.id}_`));
          if (!ok) offenders.push(`${app.id}: useService(${arg}) in ${file.replace(APPS_DIR, '')}`);
        }
      }
    }
    expect(offenders.sort()).toEqual([]);
  });
});
