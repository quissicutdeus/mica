// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * An add-on's permissions, derived from what it imports (MICA-205).
 *
 * `permissions` on a manifest is self-declared, and until now only *this repo's* apps were
 * held to it: `permissions.test.ts` walks `web/src/apps/<id>`, reads what each file imports
 * from `@mica/sdk`, and fails if a manifest declares less than its imports need. An add-on
 * built outside this repo — the population the sandbox exists for — went through no such
 * check. It could declare nothing and import `useContacts`, and the only consequence was the
 * shell refusing the call at run time with a toast the player cannot act on, long after the
 * Store showed them a permission sheet that said the app wanted nothing.
 *
 * That sheet is not decoration. MICA-196 made the Store re-prompt when an update *widens*
 * `permissions`, which is exactly as honest as the field it reads. So the derivation moved
 * out of the test and into here, where the add-on builds can run it too and refuse to emit a
 * bundle whose manifest understates it.
 *
 * Three callers, one implementation:
 *
 * - `sdk/permissions.test.ts`, over every app in the tree.
 * - `web/vite.addon.config.ts`, over each `core: false` bundle this repo builds.
 * - `tools/addon-template/vite.config.ts`, over a bundle built by somebody who has never
 *   seen this repo.
 *
 * ## Why this file imports nothing at run time
 *
 * The third caller is the constraint, and it is sharper than it looks. A Vite config is
 * loaded by **Node**, not by Vite's own pipeline: Vite bundles the config with esbuild and
 * externalises every bare specifier in it to a `file://` URL, which Node then imports. Node
 * 26 does load a `.ts` file (type stripping is on by default), but it will not resolve an
 * extensionless relative specifier *inside* one — `./permissions` and `./permissions.js`
 * both fail with `ERR_MODULE_NOT_FOUND`, and `./permissions.ts`, the one form Node accepts,
 * is what TypeScript rejects without `allowImportingTsExtensions`.
 *
 * So a module an out-of-tree add-on build can reach is a module with no relative import at
 * all. This file has none, and neither does `sdk/permissions.ts`, which is why the table can
 * be handed in as a value from a template that loads both by path. `permissionScan.test.ts`
 * spawns a real `node` and imports each of them rather than trusting that: the day somebody
 * adds an ordinary `import { x } from './y'` to either file, every out-of-tree add-on build
 * breaks with a resolver error naming a file its author does not have, and nothing else in
 * this repo would say a word.
 *
 * ## Why the table is a parameter
 *
 * Same reason `validateManifestPermissions` takes `allPermissions` rather than closing over
 * it: a test can hand this a deliberately empty or malformed table and prove the guard below
 * actually fires. `assertTable` is not ceremony — a build plugin handed `{}` would pass every
 * add-on ever submitted, silently, which is the MICA-124 shape.
 *
 * ## Why it reads text
 *
 * A manifest cannot be *evaluated* here: it imports a Svelte component, and both callers run
 * either before Vite can compile one or in a Node process that cannot. Reading the source is
 * what `web/scripts/addon-ids.js` already does for `core`, for the same reason, and the
 * comment-stripping below is the lesson from that ticket — a doc comment discussing
 * `permissions` is prose, not a declaration. `permissions.test.ts` proves the reading against
 * the evaluated manifests of every app in the tree, so the parsing is checked against real
 * answers rather than against fixtures alone.
 */

/** One row of the permission table: one permission, several, or `null` for an implicit hook. */
export type PermissionRow = string | readonly string[] | null;

/** `PERMISSION_OF`'s shape, taken as a value so this module can stay import-free (above). */
export type PermissionTable = Readonly<Record<string, PermissionRow>>;

/** One capability a bundle reaches for, and the name that discloses it. */
export interface PermissionShortfall {
  /** The `@mica/sdk` import that needs it — what the author actually wrote. */
  hook: string;
  /** The permission it requires, spelled as it must appear in `permissions`. */
  permission: string;
}

/**
 * What a manifest declares, or why that could not be read.
 *
 * `ok: false` is deliberately not "declares nothing". A `permissions` written as anything but
 * a literal array of quoted names is a value this cannot read, and a value it cannot read is
 * one it must not wave through — the same call `addon-ids.js` makes about an unreadable
 * `core`.
 */
export type DeclaredPermissions =
  | { readonly ok: true; readonly permissions: string[] }
  | { readonly ok: false; readonly reason: string };

/**
 * Block comments and whole-line `//` comments removed, before anything below reads a
 * declaration out of the text.
 *
 * A `//` inside a string truncates its own line and no other, and neither an import statement
 * nor a `permissions:` array is written on a line that could contain one.
 */
const withoutComments = (source: string): string =>
  source.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/^\s*\/\/.*$/gm, '');

/**
 * A named import from the bare `@mica/sdk` specifier, in either quote style.
 *
 * Only the bare specifier. `@mica/sdk/app` publishes `defineApp` and the manifest types,
 * which disclose nothing; `@mica/sdk/core` is refused to an add-on outright by both add-on
 * builds before this ever runs.
 *
 * A whole-statement `import type { … }` does not match, and that is the intent rather than an
 * accident of the pattern: `\s*` after `import` cannot absorb the `type` keyword, so a
 * type-only statement imports no callable name and needs no permission. A `type` specifier
 * *inside* a value import is stripped per-name below, because the statement around it is
 * still importing hooks.
 */
const SDK_IMPORT = /import\s*(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*['"]@mica\/sdk['"]/g;

/**
 * Every name one file imports from `@mica/sdk`, sorted.
 *
 * Read from the import lists rather than by searching the text for hook names: a hook
 * mentioned in a comment is not a hook used, and to call one you must import it. Aliases are
 * resolved back to the published name — `useContacts as contacts` is still `useContacts`.
 */
export function sdkImportNames(source: string): string[] {
  const names = new Set<string>();
  for (const [, list] of withoutComments(source).matchAll(SDK_IMPORT)) {
    for (const raw of list.split(',')) {
      const name = raw
        .replace(/^\s*type\s+/, '')
        .trim()
        .split(/\s+as\s+/)[0];
      if (name) names.add(name);
    }
  }
  return [...names].sort();
}

/**
 * `permissions:` in *property* position, anchored on what precedes it rather than on the
 * start of a line, so a manifest written `defineApp({ id: 'x', permissions: [] })` on one
 * line reads the same as one spread across several.
 */
const PERMISSIONS_PROPERTY = /(?:^|[{,])\s*permissions\s*:/m;
const PERMISSIONS_ARRAY = /(?:^|[{,])\s*permissions\s*:\s*\[([^\]]*)\]/m;
const STRING_LITERAL = /'([^']*)'|"([^"]*)"/g;

/** What a manifest's `permissions` declares, read from its source text. */
export function declaredPermissions(manifestSource: string): DeclaredPermissions {
  const source = withoutComments(manifestSource);
  const found = PERMISSIONS_ARRAY.exec(source);

  if (!found) {
    // Absent is a real answer — `permissions` is optional and an app that declares none is
    // making the narrowest claim there is, which is the strictest thing to check against.
    // Present-but-unreadable is not.
    if (PERMISSIONS_PROPERTY.test(source)) {
      return {
        ok: false,
        reason:
          '`permissions` is declared but is not a literal array of quoted names. This build ' +
          'reads the manifest as text — it cannot evaluate one, because a manifest imports a ' +
          'Svelte component — so write the list out literally rather than building it.'
      };
    }
    return { ok: true, permissions: [] };
  }

  const body = found[1];
  const permissions = [...body.matchAll(STRING_LITERAL)].map((m) => m[1] ?? m[2] ?? '');
  const residue = body.replaceAll(STRING_LITERAL, '').replaceAll(/[\s,]/g, '');
  if (residue !== '') {
    return {
      ok: false,
      reason:
        `\`permissions\` holds something this build cannot read as a name: '${residue}'. It is ` +
        'read as text, so every entry has to be a quoted literal — no spread, no variable, no ' +
        'expression.'
    };
  }
  return { ok: true, permissions };
}

/**
 * Refuse a table that failed to arrive.
 *
 * MICA-124 happened once already: a vocabulary list that silently came back empty made
 * every check reading it vacuously pass. Here the stakes are the same and the direction is
 * worse — an empty table means *no* import maps to a permission, so a build plugin holding
 * one would wave through every add-on ever submitted and report nothing.
 */
function assertTable(table: PermissionTable): void {
  if (table === null || typeof table !== 'object' || Object.keys(table).length === 0) {
    throw new Error(
      'micaOS permission scan: the permission table is empty or failed to import. Nothing can ' +
        'be derived from it, so this refuses to compare against it — that is a build defect, ' +
        "not the add-on's."
    );
  }
}

/**
 * Every permission the imported names need, each paired with the name that needs it.
 *
 * A name with no row is not an error: most of what an add-on imports from `@mica/sdk` is UI
 * — `Screen`, `Button`, an icon — and discloses nothing. A row of `null` is the deliberate
 * implicit set, the handful every app is built out of, which is never declared. Both are
 * skipped, and `permissions.test.ts` is what proves the table is total, so a hook with no row
 * is a failure there rather than a silent pass here.
 */
export function neededPermissions(
  names: Iterable<string>,
  table: PermissionTable
): PermissionShortfall[] {
  assertTable(table);

  const seen = new Set<string>();
  const needed: PermissionShortfall[] = [];
  for (const hook of names) {
    if (!Object.prototype.hasOwnProperty.call(table, hook)) continue;
    const row = table[hook];
    if (row === null || row === undefined) continue;
    // A kit component may need more than one: `ReportDialog` calls two host hooks at init.
    for (const permission of typeof row === 'string' ? [row] : row) {
      const key = `${hook} ${permission}`;
      if (seen.has(key)) continue;
      seen.add(key);
      needed.push({ hook, permission });
    }
  }
  return needed.sort(
    (a, b) => a.hook.localeCompare(b.hook) || a.permission.localeCompare(b.permission)
  );
}

/**
 * What the code reaches for and the manifest does not disclose.
 *
 * Declaring *more* than the scan finds stays fine — AGENTS.md §7: it is untidy, not a lie.
 * Declaring less is the failure this exists for.
 */
export function permissionShortfall(
  imported: Iterable<string>,
  declared: Iterable<string>,
  table: PermissionTable
): PermissionShortfall[] {
  const have = new Set(declared);
  return neededPermissions(imported, table).filter((need) => !have.has(need.permission));
}

/**
 * The build failure, written once so both add-on builds say the same thing.
 *
 * It names the import and the permission on the same line, because the fix is mechanical and
 * the author should not have to go and look up which hook wanted what.
 */
export function shortfallMessage(
  appId: string,
  manifestPath: string,
  shortfall: readonly PermissionShortfall[]
): string {
  const width = Math.max(0, ...shortfall.map((need) => need.hook.length));
  const rows = shortfall
    .map((need) => `  ${need.hook.padEnd(width)}  needs '${need.permission}'`)
    .join('\n');

  return (
    `'${appId}' imports capabilities its manifest does not declare:\n\n${rows}\n\n` +
    `Add those names to \`permissions\` in ${manifestPath}, or stop importing the hook. ` +
    `A player is shown this list before they install, and is asked again when an update ` +
    `widens it, so an add-on that declares less than it uses is a disclosure that is not ` +
    `true — the shell refuses the undeclared call at run time and the player sees a toast ` +
    `they cannot act on. Declaring more than you use is fine.`
  );
}
