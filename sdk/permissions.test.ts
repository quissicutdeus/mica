// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
// MICA-176: jsdom because this file's subject now transitively imports `services/admin.ts`,
// which reads `window` at module scope. Not a workaround for `isBrowser()`, and do not
// "simplify" this line away by giving that predicate a `typeof` guard — MICA-177 is the
// bug and carries the reasoning, including why both cheap guards are worse than the crash.
/**
 * MICA-176: which facet set this file's subject resolves against. A hook no longer
 * carries its facet — `src/main.ts` picks the in-process set for the shell and `bootAddOn`
 * picks the iframe twins for an add-on — so a test file, having neither entry point, says
 * which side it is standing in for. In-process, because a unit test stands in for the shell.
 */
import '../web/src/host/registerFacets';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ALL_PERMISSIONS, defineApp } from './manifest';
import {
  HOOK_OF_FACET,
  PERMISSION_OF,
  permissionOfFacet,
  DENIED_FACETS,
  SAFE_IMPLICIT_FACETS,
  FACET_MEMBERS,
  membersOfFacet,
  validateManifestPermissions
} from './permissions';
import { declaredPermissions, permissionShortfall, sdkImportNames } from './lib/permissionScan';
import { bundledAddOns, registeredApps } from '../web/src/shell/state/registry';

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

// MICA-172: `__dirname` is `sdk/` at the repo root now. One hop up is the repo root,
// and the phone it reasons about is its sibling `web/`.
const APPS_DIR = join(__dirname, '..', 'web', 'src', 'apps');

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.(svelte|ts)$/.test(entry) && !entry.endsWith('.test.ts') ? [full] : [];
  });

/**
 * What an app imports from `@gos/sdk`, across every file it owns.
 *
 * The per-file reading is `lib/permissionScan.ts` since MICA-205, and this walk is the
 * only part left here. The scanner moved because the two add-on builds have to run the same
 * derivation over a bundle nobody in this repo can see — an add-on built outside it declares
 * its own permissions, and until that ticket nothing but this test ever checked one.
 */
const sdkImportsOf = (appId: string): Set<string> => {
  const names = new Set<string>();
  for (const file of walk(join(APPS_DIR, appId))) {
    for (const name of sdkImportNames(readFileSync(file, 'utf8'))) names.add(name);
  }
  return names;
};

const APPS = [...registeredApps, ...bundledAddOns];

describe('declared permissions', () => {
  it('finds the apps to check', () => {
    expect(APPS.length).toBeGreaterThan(10);
  });

  it('covers every capability the app actually reaches for', () => {
    const understated = APPS.flatMap((app) =>
      permissionShortfall(sdkImportsOf(app.id), app.permissions ?? [], PERMISSION_OF).map(
        (need) => `${app.id}: uses ${need.hook}, does not declare '${need.permission}'`
      )
    );
    expect([...new Set(understated)].sort()).toEqual([]);
  });

  /**
   * The add-on builds read a manifest as **text**, and this is what says that reading is
   * right.
   *
   * `web/vite.addon.config.ts` and `tools/addon-template/vite.config.ts` both derive the
   * declared list with `declaredPermissions`, because neither can evaluate a manifest: one
   * runs while Vite is still reading its own config, the other in a Node process that cannot
   * compile the Svelte component a manifest imports. A parser that quietly read one manifest
   * shape and not another would not fail either build — it would report an empty list, and
   * an empty list understates nothing it was not already asked about, so the build would go
   * green on precisely the manifest it should have refused.
   *
   * So the text answer is held against the evaluated one, for every app in the tree. These
   * are the manifests the registry actually loaded, so a shape no fixture thought of is
   * covered the moment somebody writes one.
   */
  it('reads the same permissions out of a manifest as evaluating it does', () => {
    const disagreements = APPS.flatMap((app) => {
      const source = readFileSync(join(APPS_DIR, app.id, 'manifest.ts'), 'utf8');
      const read = declaredPermissions(source);
      if (!read.ok) return [`${app.id}: could not be read as text — ${read.reason}`];
      const evaluated = [...(app.permissions ?? [])].sort();
      const asText = [...read.permissions].sort();
      return asText.join(',') === evaluated.join(',')
        ? []
        : [
            `${app.id}: text says [${asText.join(', ')}], the manifest evaluates to ` +
              `[${evaluated.join(', ')}]`
          ];
    });
    expect(disagreements).toEqual([]);
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
    const dir = join(__dirname, '..', 'web', 'src', 'host', 'facets');
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

/**
 * MICA-33: what stops MICA-21's bug class from coming back with a *different* facet
 * name. MICA-21 fixed one specific hole — `onAppForeground` reachable by a raw
 * `call`/`subscribe` with no permission and no `pinAppId`/`decodeArgs` pass — by hand-
 * listing five bare-function facets in `DENIED_FACETS`. Nothing stopped a *sixth* implicit
 * facet, shaped the same way, from being added later without anyone remembering to deny
 * it — exactly the class of gap `SAFE_IMPLICIT_FACETS` exists to close: every implicit
 * facet must be explicitly accounted for, so a new one that arrives unclassified fails
 * this test immediately rather than shipping silently.
 *
 * Deliberately scoped to *implicit* facets, not every facet `DENIED_FACETS` happens to
 * contain — `clearAppStorage`/`appStorageBytes` are denied for the same shape reason but
 * require the real `storage` permission, so they are already protected regardless of
 * this check and need no entry in `SAFE_IMPLICIT_FACETS` (which is *only* for implicit
 * facets confirmed safe) to pass it.
 */
describe('every implicit facet is classified (MICA-33)', () => {
  const implicitFacets = Object.entries(HOOK_OF_FACET)
    .filter(([, hook]) => PERMISSION_OF[hook] === null)
    .map(([facet]) => facet);

  it('finds at least the implicit facets this test was written against', () => {
    // A sanity floor, not a ceiling — guards against the filter above silently matching
    // nothing (e.g. a PERMISSION_OF/HOOK_OF_FACET shape change) and every check below
    // passing vacuously.
    expect(implicitFacets.length).toBeGreaterThanOrEqual(9);
  });

  it('every implicit facet is denied, or confirmed safe, but never both', () => {
    const unclassified = implicitFacets.filter(
      (f) => !DENIED_FACETS.has(f) && !SAFE_IMPLICIT_FACETS.has(f)
    );
    expect(
      unclassified,
      'add it to DENIED_FACETS or SAFE_IMPLICIT_FACETS in permissions.ts'
    ).toEqual([]);

    const inBoth = implicitFacets.filter(
      (f) => DENIED_FACETS.has(f) && SAFE_IMPLICIT_FACETS.has(f)
    );
    expect(inBoth, 'a facet cannot be both denied and safe').toEqual([]);
  });

  it('has no stale entries in SAFE_IMPLICIT_FACETS naming a facet that is no longer implicit', () => {
    // DENIED_FACETS is deliberately not checked here — it legitimately contains
    // non-implicit entries (see this block's own doc comment above).
    const stale = [...SAFE_IMPLICIT_FACETS].filter((f) => !implicitFacets.includes(f));
    expect(stale, 'remove it from SAFE_IMPLICIT_FACETS — no longer an implicit facet').toEqual([]);
  });
});

/**
 * MICA-196: the third table in this file, and the one nothing used to check.
 *
 * `PERMISSION_OF` and `HOOK_OF_FACET` are proved total above. `FACET_MEMBERS` replaces the
 * `MEMBER_ALLOWLIST` that used to live in `IframeHostServer.ts`, which was default-*allow*
 * — a facet absent from it exposed every member — and so failed one facet at a time, four
 * tickets deep (MICA-63, -127, -162, each closing one instance). Default-deny only helps
 * if it is also total: a facet with no row is a facet an add-on cannot use at all, which is
 * a loud failure rather than a silent opening, but it is still a failure, so this is what
 * makes adding a facet mean adding a row.
 */
describe('every reachable facet declares its members (MICA-196)', () => {
  const TWINS = join(__dirname, 'host', 'iframe', 'facets');
  const facets = Object.keys(HOOK_OF_FACET);
  const reachable = facets.filter((f) => !DENIED_FACETS.has(f));

  it('finds at least the facets this test was written against', () => {
    // The same sanity floor the implicit-facet block above uses, and for the same reason:
    // a shape change to `HOOK_OF_FACET` that made `facets` empty would pass every check
    // below vacuously.
    expect(facets.length).toBeGreaterThanOrEqual(50);
    expect(reachable.length).toBeGreaterThanOrEqual(45);
  });

  it('every facet an add-on can reach has a row', () => {
    const missing = reachable.filter((f) => membersOfFacet(f) === undefined);
    expect(
      missing,
      'add a row to FACET_MEMBERS in permissions.ts — an empty one if nothing crosses the wire'
    ).toEqual([]);
  });

  it('has no row for a facet that is denied outright, or that is not a facet at all', () => {
    // A row for a denied facet reads as "these members are reachable" and is never true —
    // `requireMember` refuses the facet before it ever looks at the row.
    const denied = Object.keys(FACET_MEMBERS).filter((f) => DENIED_FACETS.has(f));
    expect(denied, 'remove it: DENIED_FACETS already refuses the whole facet').toEqual([]);

    const unknown = Object.keys(FACET_MEMBERS).filter((f) => !facets.includes(f));
    expect(unknown, 'remove it from FACET_MEMBERS — no such facet').toEqual([]);
  });

  /**
   * The member half. A row is bounded by what the facet's own iframe twin sends over the
   * wire, so a member no twin mentions is either a typo or a name that was renamed out from
   * under the table — both of which read as a working allowance and are not one.
   *
   * Read from the twin's source rather than from a constructed facet object: constructing
   * one needs a live host and, for several, real factory arguments. The twins name every
   * member as a string literal (`fn('contacts', [], 'addContact')`, `subscribe('onAny', …)`),
   * which is exactly what this looks for.
   */
  it('every member named is one its own iframe twin actually sends', () => {
    const stale: string[] = [];
    for (const facet of reachable) {
      const members = membersOfFacet(facet) ?? [];
      if (members.length === 0) continue;
      const file = ['.ts', '.svelte.ts']
        .map((ext) => join(TWINS, `${facet}${ext}`))
        .find(existsSync);
      if (!file) {
        stale.push(`${facet}: no twin under sdk/host/iframe/facets`);
        continue;
      }
      const source = readFileSync(file, 'utf8');
      for (const member of members) {
        if (!new RegExp(`['"]${member}['"]`).test(source)) {
          stale.push(`${facet}.${member}: the twin never names it`);
        }
      }
    }
    expect(stale.sort(), 'a renamed or removed member left a dead row behind').toEqual([]);
  });

  it('names every member once, so a row cannot quietly say the same thing twice', () => {
    const duplicated = Object.entries(FACET_MEMBERS)
      .filter(([, members]) => new Set(members).size !== members.length)
      .map(([facet]) => facet);
    expect(duplicated).toEqual([]);
  });

  /**
   * The five rows that are deliberately narrower than their twin. Asserted by name because
   * the reasoning is the ticket, not the table: each of these was a real hole somebody
   * found, and a future row edit that quietly re-opens one should redden the build rather
   * than pass because the member does appear in the twin.
   */
  it('keeps the writes no add-on may reach out of reach', () => {
    expect(membersOfFacet('appRegistryWrite')).toEqual([]);
    expect(membersOfFacet('notificationSettingsWrite')).toEqual([]);
    expect(membersOfFacet('keybindsWrite')).toEqual([]);
    expect(membersOfFacet('systemHardwareWrite')).toEqual([
      'setVolume',
      'setRingMode',
      'previewRingtone'
    ]);
    for (const member of ['installFromCatalog', 'registerAddOn', 'unregisterApp']) {
      expect(membersOfFacet('appRegistry')).not.toContain(member);
    }
    for (const member of ['setDndEnabled', 'setAppNotificationPolicy', 'setToastsEnabled']) {
      expect(membersOfFacet('notificationSettings')).not.toContain(member);
    }
  });

  /**
   * MICA-201. The consent record is what the shell checks *instead of* trusting the
   * installed manifest, so an add-on able to name either member could grant itself the
   * permissions it was refused, or read what every other add-on was granted. Both live on
   * `appRegistryWrite` precisely because its row is empty; asserted by name so a future
   * edit that gives that row members has to face this test rather than silently expose
   * two more.
   */
  it("keeps the consent record out of an add-on's reach", () => {
    for (const member of ['recordConsent', 'grantedPermissions']) {
      expect(membersOfFacet('appRegistryWrite') ?? []).not.toContain(member);
      expect(membersOfFacet('appRegistry') ?? []).not.toContain(member);
    }
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

/**
 * MICA-128: `defineApp` never checked a manifest's `permissions` array against
 * `ALL_PERMISSIONS` at runtime — only the `AppPermission` type does, and only for a
 * manifest this repo itself typechecks. A published add-on, or a hand-written manifest
 * this build never sees, could carry `'notifcations'` or `'contacts '` and load exactly
 * as if it had declared nothing: no error at install, no row in the permission sheet, and
 * an `AppPermissionError` thrown into the app's `ErrorBoundary` the first time it actually
 * called the hook the typo was meant to name.
 */
describe('validateManifestPermissions', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('says nothing about a manifest that only declares real permissions', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    validateManifestPermissions('contacts_app', ['contacts', 'notifications'], ALL_PERMISSIONS);

    expect(warn).not.toHaveBeenCalled();
  });

  it('says nothing about a manifest that declares no permissions at all', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    validateManifestPermissions('quiet_app', [], ALL_PERMISSIONS);

    expect(warn).not.toHaveBeenCalled();
  });

  it('warns, but does not throw, on an unrecognized permission', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() =>
      validateManifestPermissions('typo_app', ['notifcations'], ALL_PERMISSIONS)
    ).not.toThrow();

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("'typo_app' declares permission 'notifcations'")
    );
  });

  it('suggests the real name for a one-edit-distance typo', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    validateManifestPermissions('typo_app', ['notifcations'], ALL_PERMISSIONS);
    validateManifestPermissions('spacey_app', ['contacts '], ALL_PERMISSIONS);
    validateManifestPermissions('sep_app', ['system_hardware'], ALL_PERMISSIONS);

    expect(warn).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("Did you mean 'notifications'?")
    );
    expect(warn).toHaveBeenNthCalledWith(2, expect.stringContaining("Did you mean 'contacts'?"));
    expect(warn).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("Did you mean 'system-hardware'?")
    );
  });

  it('offers no suggestion for a name that is not a near miss of anything real', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    validateManifestPermissions('madeup_app', ['teleportation'], ALL_PERMISSIONS);

    const [message] = warn.mock.calls[0] as [string];
    expect(message).toContain("declares permission 'teleportation'");
    expect(message).not.toContain('Did you mean');
  });

  it('still loads the app: an unrecognized permission never stops the manifest', () => {
    // The failure this ticket is about is the *unsafe* direction — silently accepting a
    // typo. The fix must not overcorrect into refusing to load over one, which would
    // break the legitimate case (an add-on built against a newer phone's vocabulary,
    // opened on an older one) to catch the illegitimate one.
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const manifest = defineApp({
      id: 'forward_compatible',
      tile: { bg: 'bg-blue-600' },
      icon: null,
      core: false,
      // A manifest this repo never typechecks is exactly the case under test — the cast is
      // what a real published bundle's untyped JS effectively does.
      permissions: ['notifcations', 'future_capability'] as never
    });

    expect(manifest.id).toBe('forward_compatible');
    expect(manifest.permissions).toEqual(['notifcations', 'future_capability']);
  });

  it('fails loudly, not silently, when the vocabulary it checks against is broken', () => {
    // MICA-124 happened once already: a table that silently came back empty made every
    // check reading it vacuously pass. An empty or unimportable ALL_PERMISSIONS must not
    // let every manifest through as if nothing were wrong — it must stop the check outright.
    expect(() => validateManifestPermissions('any_app', ['contacts'], [])).toThrow(
      /ALL_PERMISSIONS is empty or failed to import/
    );
  });

  it('the real ALL_PERMISSIONS is in fact non-empty', () => {
    // A sanity floor on the table this whole check leans on, not a ceiling — see
    // 'declares only names in the vocabulary' above for the same shape of guard.
    expect(ALL_PERMISSIONS.length).toBeGreaterThan(10);
  });
});
