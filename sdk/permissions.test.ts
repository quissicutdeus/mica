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
import { describe, it, expect, vi, afterEach, afterAll, beforeAll } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
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
 * What an app imports from `@mica/sdk`, across every file it owns.
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
    // The **last** declaration in the file: an overloaded hook (`useService`, MICA-308)
    // writes its signatures first and its implementation — the body with the `guarded()`
    // call in it — after them. A hook with one declaration is unaffected.
    const re = new RegExp(String.raw`export (?:function|const) ${name}\b`, 'g');
    for (const { file, text } of hostSources) {
      const matches = [...text.matchAll(re)];
      const match = matches[matches.length - 1];
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

  it('keeps the frame setters (MICA-236) off the add-on allowlist, as setLocale is', () => {
    const members = membersOfFacet('displayWrite') ?? [];
    expect(members).not.toContain('setFrame');
    expect(members).not.toContain('setFrameColor');
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
      'previewRingtone',
      // MICA-256: auditioning a tone, never choosing one for the whole phone.
      'previewNotificationTone'
    ]);
    for (const member of ['setRingtone', 'setNotificationTone']) {
      expect(membersOfFacet('systemHardwareWrite')).not.toContain(member);
    }
    for (const member of ['installFromCatalog', 'registerAddOn', 'unregisterApp']) {
      expect(membersOfFacet('appRegistry')).not.toContain(member);
    }
    // MICA-237: the server-relayed catalog is the Store's, not an add-on's to trigger.
    for (const facet of ['appRegistry', 'appRegistryWrite']) {
      expect(membersOfFacet(facet) ?? []).not.toContain('fetchRemoteCatalog');
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
   * component init where there is no context to read the app id from. For a sandboxed
   * add-on the shell's `serviceAllowed` refuses a foreign id at run time as well; for a
   * `core: true` app, which runs in-process, **this test is the only check there is**.
   *
   * So it reads the syntax tree, not the text: a comment, a string or a doc example that
   * mentions `useService` proves nothing either way. Every reference to `useService` in an
   * app must be a call with one argument, and that argument must be one of:
   *
   * - **A string literal** in the app's namespace. Anything computed is an id this test
   *   cannot see, and is refused.
   * - **An identifier naming a declaration** (MICA-308), traced to
   *   `const <name> = defineAddonService({ id: '<literal>', ... })`: a top-level `const`,
   *   the only binding of that name anywhere in its module, so nothing can shadow it; and
   *   `defineAddonService` itself the module's only binding of that name, imported from the
   *   package that defines it. The object is a literal with exactly one `id`, a string, and
   *   no spread or computed key — either of which could put a different `id` there at run
   *   time. The declaration may sit in the calling module or be a named import, one hop,
   *   from a `.ts` module inside the app's own directory that `export const`s it.
   *
   * Anything else is refused rather than guessed at: a hook aliased on import, passed
   * around, or called with an expression; a declaration re-exported, rebuilt, wrapped, or
   * declared twice. In component markup, where nothing can be traced, only a literal is
   * accepted.
   */
  const ts = createRequire(join(__dirname, '..', 'package.json'))('typescript-ast-parser');
  /** The modules `defineAddonService` may come from: the SDK, and the package it re-exports. */
  const DEFINERS = new Set(['@mica/sdk', '@mica/shared/addonService']);
  const ID = /^[a-z0-9_]+$/;
  const SCRIPT = /<script\b[^>]*>([\s\S]*?)<\/script>/g;

  /** A file's TypeScript and, for a component, the markup around it with comments removed. */
  const partsOf = (file: string): { script: string; markup: string } => {
    const text = readFileSync(file, 'utf8');
    if (!file.endsWith('.svelte')) return { script: text, markup: '' };
    return {
      script: [...text.matchAll(SCRIPT)].map((m) => m[1]).join('\n;\n'),
      markup: text
        .replace(SCRIPT, '')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, '')
        .replace(/<!--[\s\S]*?-->/g, '')
    };
  };

  /** Every node of a module's syntax tree, depth first. Comments are not nodes. */
  const nodesOf = (file: string, script: string): any[] => {
    const nodes: any[] = [];
    const visit = (node: any) => {
      nodes.push(node);
      ts.forEachChild(node, visit);
    };
    visit(ts.createSourceFile(file, script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS));
    return nodes;
  };

  /** Every declaration binding `name` as a value, at any depth: shadowing counts. */
  const bindingsOf = (nodes: any[], name: string): any[] =>
    nodes.filter(
      (n) =>
        (ts.isVariableDeclaration(n) ||
          ts.isParameter(n) ||
          ts.isBindingElement(n) ||
          ts.isFunctionDeclaration(n) ||
          ts.isFunctionExpression(n) ||
          ts.isClassDeclaration(n) ||
          ts.isClassExpression(n) ||
          ts.isImportSpecifier(n) ||
          ts.isImportClause(n) ||
          ts.isNamespaceImport(n) ||
          ts.isImportEqualsDeclaration(n) ||
          ts.isEnumDeclaration(n) ||
          ts.isModuleDeclaration(n)) &&
        n.name !== undefined &&
        ts.isIdentifier(n.name) &&
        n.name.text === name
    );

  /** The `ImportDeclaration` an `ImportSpecifier` belongs to. */
  const importOf = (specifier: any): any => specifier.parent.parent.parent;

  /** `name`'s one binding in the module, if it is a top-level `const` (and exported, if asked). */
  const soleTopLevelConst = (nodes: any[], name: string, exported: boolean): any => {
    const bound = bindingsOf(nodes, name);
    if (bound.length !== 1 || !ts.isVariableDeclaration(bound[0])) return undefined;
    const [decl] = bound;
    const statement = decl.parent?.parent;
    if (
      !(decl.parent.flags & ts.NodeFlags.Const) ||
      !ts.isVariableStatement(statement) ||
      !ts.isSourceFile(statement.parent)
    ) {
      return undefined;
    }
    const isExported = (statement.modifiers ?? []).some(
      (m: any) => m.kind === ts.SyntaxKind.ExportKeyword
    );
    return exported && !isExported ? undefined : decl;
  };

  /** The id of `defineAddonService({ id: '<literal>', ... })`, when it can be read exactly. */
  const declaredId = (init: any, nodes: any[]): string | undefined => {
    if (!init || !ts.isCallExpression(init) || init.arguments.length !== 1) return undefined;
    if (!ts.isIdentifier(init.expression) || init.expression.text !== 'defineAddonService') {
      return undefined;
    }
    const definers = bindingsOf(nodes, 'defineAddonService');
    if (
      definers.length !== 1 ||
      !ts.isImportSpecifier(definers[0]) ||
      definers[0].propertyName !== undefined ||
      !DEFINERS.has(importOf(definers[0]).moduleSpecifier.text)
    ) {
      return undefined;
    }
    const object = init.arguments[0];
    if (!ts.isObjectLiteralExpression(object)) return undefined;
    const ids: any[] = [];
    for (const property of object.properties) {
      if (ts.isSpreadAssignment(property)) return undefined;
      if (property.name === undefined || ts.isComputedPropertyName(property.name)) return undefined;
      if (property.name.text === 'id') ids.push(property);
    }
    if (ids.length !== 1) return undefined;
    const [id] = ids;
    return ts.isPropertyAssignment(id) && ts.isStringLiteral(id.initializer)
      ? id.initializer.text
      : undefined;
  };

  /** A relative import's `.ts` file, if it resolves to one inside `appDir`. */
  const resolveInApp = (from: string, specifier: string, appDir: string): string | undefined => {
    const base = join(dirname(from), specifier);
    const file = [base, `${base}.ts`, join(base, 'index.ts')].find(
      (candidate) =>
        candidate.endsWith('.ts') && existsSync(candidate) && statSync(candidate).isFile()
    );
    return file !== undefined && file.startsWith(`${appDir}${sep}`) ? file : undefined;
  };

  /** The service id the identifier `name` names in the module, or `undefined` if unprovable. */
  const tracedId = (name: string, file: string, nodes: any[], appDir: string) => {
    const local = soleTopLevelConst(nodes, name, false);
    if (local) return declaredId(local.initializer, nodes);

    const bound = bindingsOf(nodes, name);
    if (bound.length !== 1 || !ts.isImportSpecifier(bound[0]) || bound[0].isTypeOnly) {
      return undefined;
    }
    const declaration = importOf(bound[0]);
    if (declaration.importClause?.isTypeOnly) return undefined;
    const target = resolveInApp(file, declaration.moduleSpecifier.text, appDir);
    if (target === undefined) return undefined;

    const imported = (bound[0].propertyName ?? bound[0].name).text;
    const targetNodes = nodesOf(target, readFileSync(target, 'utf8'));
    // An `export { other as journal }` beside the const would be the binding actually imported.
    if (targetNodes.some((n) => ts.isExportSpecifier(n) && n.name.text === imported)) {
      return undefined;
    }
    const remote = soleTopLevelConst(targetNodes, imported, true);
    return remote ? declaredId(remote.initializer, targetNodes) : undefined;
  };

  /**
   * Every reference to `useService` under `appDir` whose id is not provably `appId`'s own,
   * and how many calls were read — so a scan that goes blind cannot pass as a clean one.
   */
  const scan = (appId: string, appDir: string): { offenders: string[]; calls: number } => {
    let calls = 0;
    const own = (id: string | undefined) =>
      id !== undefined && ID.test(id) && (id === appId || id.startsWith(`${appId}_`));
    const offenders: string[] = [];
    for (const file of walk(appDir)) {
      const at = file.replace(appDir, '');
      const { script, markup } = partsOf(file);
      const nodes = nodesOf(file, script);

      for (const node of nodes) {
        if (!ts.isIdentifier(node) || node.text !== 'useService') continue;
        const parent = node.parent;
        // The import of the hook itself, unaliased. An alias is a name this test would lose.
        if (ts.isImportSpecifier(parent) && parent.name === node && !parent.propertyName) continue;
        const callee =
          ts.isPropertyAccessExpression(parent) && parent.name === node ? parent : node;
        const call = callee.parent;
        if (!ts.isCallExpression(call) || call.expression !== callee) {
          offenders.push(`${appId}: useService referenced as \`${parent.getText()}\` in ${at}`);
          continue;
        }
        calls++;
        const args = call.arguments.map((a: any) => a.getText()).join(', ');
        const [arg] = call.arguments;
        const id =
          call.arguments.length !== 1
            ? undefined
            : ts.isStringLiteral(arg)
              ? arg.text
              : ts.isIdentifier(arg)
                ? tracedId(arg.text, file, nodes, appDir)
                : undefined;
        if (!own(id)) offenders.push(`${appId}: useService(${args}) in ${at}`);
      }

      // Markup: nothing to trace, so a literal or nothing.
      for (const match of markup.matchAll(/\buseService\b/g)) {
        const literal = /^useService\(\s*['"]([^'"]*)['"]\s*\)/.exec(
          markup.slice(match.index)
        )?.[1];
        calls++;
        if (!own(literal)) offenders.push(`${appId}: useService in the markup of ${at}`);
      }
    }
    return { offenders, calls };
  };
  const offendersIn = (appId: string, appDir: string): string[] => scan(appId, appDir).offenders;

  it('every app calls useService with a literal id in its own namespace', () => {
    const scans = APPS.map((app) => scan(app.id, join(APPS_DIR, app.id)));
    // Notes, Hodlr, Places, Jobs and Blabber all call it; a parse that found none would
    // report every app clean.
    expect(scans.reduce((sum, { calls }) => sum + calls, 0)).toBeGreaterThanOrEqual(5);
    expect(scans.flatMap(({ offenders }) => offenders).sort()).toEqual([]);
  });

  describe('a declaration is read as its id, and held to the same rule', () => {
    let root: string;
    const app = (files: Record<string, string>): string => {
      const dir = join(root, 'journal');
      rmSync(dir, { recursive: true, force: true });
      for (const [name, body] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, name)), { recursive: true });
        writeFileSync(join(dir, name), body);
      }
      return dir;
    };
    const IMPORTS = `import { defineAddonService, useService } from '@mica/sdk';\n`;
    const declaration = (id: string) =>
      `${IMPORTS}export const journal = defineAddonService({ id: '${id}', actions: { list: { input: {} } } });\n`;
    /** One module calling `useService(journal)` on `journal` as `body` declares it. */
    const caller = (body: string) => `${IMPORTS}${body}\nuseService(journal);\n`;

    beforeAll(() => {
      root = mkdtempSync(join(tmpdir(), 'mica-useservice-'));
    });
    afterAll(() => {
      rmSync(root, { recursive: true, force: true });
    });

    it('accepts a declaration of its own id, imported, aliased, local, or in a component', () => {
      const dir = app({
        'service.ts': declaration('journal'),
        'index.svelte':
          `<script lang="ts">\n  import { useService } from '@mica/sdk';\n` +
          `  import { journal } from './service';\n  useService(journal).call('list');\n` +
          `</script>\n\n<!-- useService(somethingElse) in a comment is not a call -->\n` +
          `<p>{useService('journal').id}</p>\n`,
        'store.ts': `${IMPORTS}import { journal as j } from './service';\nuseService(j);\n`,
        'local.ts': `${IMPORTS}const own = defineAddonService({ id: 'journal_extra', actions: {} });\nuseService(own);\n`,
        'shared.ts': `import { defineAddonService } from '@mica/shared/addonService';\nimport { useService } from '@mica/sdk';\nconst own = defineAddonService({ 'id': 'journal', actions: {} });\nuseService(own);\n`,
        'literal.ts': `${IMPORTS}// useService(anything) in a comment is not a call\nuseService('journal_dms');\n`
      });
      expect(offendersIn('journal', dir)).toEqual([]);
    });

    it("refuses a declaration whose id is not the app's own, as it refuses the string", () => {
      const dir = app({
        'service.ts': declaration('contacts'),
        'a.ts': `${IMPORTS}import { journal } from './service';\nuseService(journal);\n`,
        'b.ts': `${IMPORTS}useService('contacts');\n`
      });
      expect(offendersIn('journal', dir).sort()).toEqual([
        "journal: useService('contacts') in /b.ts",
        'journal: useService(journal) in /a.ts'
      ]);
    });

    /**
     * Each of these has a literal `id: 'journal'` somewhere in its text, so a pattern match
     * over the source would accept it — and each one's run-time id can be another app's.
     */
    it.each([
      [
        'a spread after the id',
        `const journal = defineAddonService({ id: 'journal', ...foreign });`
      ],
      [
        'a spread before the id',
        `const journal = defineAddonService({ ...foreign, id: 'journal' });`
      ],
      [
        'a second id',
        `const journal = defineAddonService({ id: 'journal', actions: {}, id: 'contacts' });`
      ],
      [
        'a computed key',
        `const journal = defineAddonService({ id: 'journal', [key]: 'contacts', actions: {} });`
      ],
      [
        'an id that is not a string literal',
        `const journal = defineAddonService({ id: \`journal\`, actions: {} });`
      ],
      [
        'an id behind a getter',
        `const journal = defineAddonService({ get id() { return 'journal'; }, actions: {} });`
      ],
      [
        'the declaration only in a comment',
        `// const journal = defineAddonService({ id: 'journal', actions: {} });\nconst journal = foreign;`
      ],
      [
        'the declaration only in a block comment',
        `/* const journal = defineAddonService({ id: 'journal', actions: {} }); */\nconst journal = make();`
      ],
      [
        'a shadowing local',
        `const journal = defineAddonService({ id: 'journal', actions: {} });\nfunction f() { const journal = foreign; return journal; }`
      ],
      [
        'a shadowing parameter',
        `const journal = defineAddonService({ id: 'journal', actions: {} });\nconst f = (journal: unknown) => journal;`
      ],
      [
        'a let rather than a const',
        `let journal = defineAddonService({ id: 'journal', actions: {} });`
      ],
      [
        'a declaration inside a block',
        `if (true) { const journal = defineAddonService({ id: 'journal', actions: {} }); }`
      ],
      [
        'a wrapped declaration',
        `const journal = defineAddonService({ id: 'journal', actions: {} }) as never;`
      ]
    ])('refuses %s', (_case, body) => {
      const dir = app({ 'a.ts': caller(body) });
      expect(offendersIn('journal', dir)).toEqual(['journal: useService(journal) in /a.ts']);
    });

    it('refuses a defineAddonService that is not the real one', () => {
      const dir = app({
        'local.ts':
          `import { useService } from '@mica/sdk';\n` +
          `const defineAddonService = (o: object) => ({ ...o, id: 'contacts' });\n` +
          `const journal = defineAddonService({ id: 'journal', actions: {} });\nuseService(journal);\n`,
        'aliased.ts':
          `import { useService, addonOutput as defineAddonService } from '@mica/sdk';\n` +
          `const journal = defineAddonService({ id: 'journal', actions: {} });\nuseService(journal);\n`,
        'elsewhere.ts':
          `import { useService } from '@mica/sdk';\nimport { defineAddonService } from './fake';\n` +
          `const journal = defineAddonService({ id: 'journal', actions: {} });\nuseService(journal);\n`
      });
      expect(offendersIn('journal', dir)).toHaveLength(3);
    });

    it('refuses an import it cannot follow to exactly one exported const', () => {
      const dir = app({
        'service.ts': declaration('journal'),
        'unexported.ts': `${IMPORTS}const journal = defineAddonService({ id: 'journal', actions: {} });\n`,
        'renamed.ts': `${declaration('journal')}const other = foreign;\nexport { other as journal2 };\nexport { journal as journal3 };\n`,
        'reexport.ts': `export { journal } from './service';\n`,
        'twice.ts': `${declaration('journal')}function g(journal: unknown) { return journal; }\n`,
        'a.ts': `${IMPORTS}import { journal } from './unexported';\nuseService(journal);\n`,
        'b.ts': `${IMPORTS}import { journal3 as journal } from './renamed';\nuseService(journal);\n`,
        'c.ts': `${IMPORTS}import { journal } from './reexport';\nuseService(journal);\n`,
        'd.ts': `${IMPORTS}import { journal } from './twice';\nuseService(journal);\n`,
        'e.ts': `${IMPORTS}import { journal } from './service';\nconst g = (journal: string) => journal;\nuseService(journal);\n`,
        'f.ts': `${IMPORTS}import * as svc from './service';\nuseService(svc.journal);\n`
      });
      expect(offendersIn('journal', dir).sort()).toEqual(
        ['a', 'b', 'c', 'd', 'e']
          .map((f) => `journal: useService(journal) in /${f}.ts`)
          .concat('journal: useService(svc.journal) in /f.ts')
          .sort()
      );
    });

    it('refuses an id it cannot trace: undeclared, out of the app, inline, or computed', () => {
      const dir = app({
        'a.ts': `${IMPORTS}useService(nowhere);\n`,
        'b.ts': `${IMPORTS}import { journal } from '../elsewhere/service';\nuseService(journal);\n`,
        'c.ts': `${IMPORTS}useService(defineAddonService({ id: 'journal', actions: {} }));\n`,
        'd.ts': `${IMPORTS}useService(decl.id);\n`
      });
      // A real declaration of the right id, so the refusal is about where it lives.
      mkdirSync(join(root, 'elsewhere'), { recursive: true });
      writeFileSync(join(root, 'elsewhere', 'service.ts'), declaration('journal'));
      expect(offendersIn('journal', dir)).toHaveLength(4);
    });

    it('refuses the hook itself escaping: aliased, passed around, or traced only in markup', () => {
      const dir = app({
        'service.ts': declaration('journal'),
        'a.ts': `import { useService as svc } from '@mica/sdk';\nsvc('contacts');\n`,
        'b.ts': `${IMPORTS}const door = useService;\ndoor('contacts');\n`,
        'c.ts': `import * as sdk from '@mica/sdk';\nsdk.useService(foreign);\n`,
        'd.svelte':
          `<script lang="ts">\n  import { useService } from '@mica/sdk';\n  import { journal } from './service';\n</script>\n` +
          `<p>{useService(journal).id}</p>\n`
      });
      const found = offendersIn('journal', dir).sort();
      expect(found).toEqual(
        [
          'journal: useService in the markup of /d.svelte',
          'journal: useService referenced as `door = useService` in /b.ts',
          'journal: useService referenced as `useService as svc` in /a.ts',
          'journal: useService(foreign) in /c.ts'
        ].sort()
      );
    });
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
