import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * The kit may not reach the shell.
 *
 * `@gphone/sdk` is two things wearing one name (MICA-16). The **kit** — `ui/`, `kit/`,
 * `utils.ts`, `types.ts`, `app.ts` and what they import — is what an add-on bundles into
 * its own file. The **host API** — `host/` — is what an add-on asks the running shell for.
 * When add-ons move out of the shell's JS context, the kit travels with them and the host
 * API becomes a message. So the kit must not import `shell/`, `services/` or `nui/` by
 * value: there is nothing at the other end of that import inside an add-on's bundle.
 *
 * A kit file may use a host *hook* — `ToggleSwitch` plays a click through `useSound()`.
 * That is the whole point: it asks, rather than reaching.
 */

const SDK = __dirname;
const SRC = join(SDK, '..');
const WEB = join(SRC, '..');
const ROOT = join(WEB, '..');

/** Directories and files that travel with an add-on. */
const KIT = [
  join(SDK, 'ui'),
  join(SDK, 'kit'),
  join(SDK, 'utils.ts'),
  join(SDK, 'components.ts'),
  join(SDK, 'icons.ts'),
  join(SDK, 'types.ts'),
  join(SDK, 'app.ts'),
  join(SDK, 'manifest.ts'),
  join(SDK, 'lazyBadge.ts'),
  join(SDK, 'version.ts')
];

const walk = (path: string): string[] => {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path).flatMap((entry) => walk(join(path, entry)));
};

const FILES = KIT.flatMap(walk).filter((f) => /\.(svelte|ts)$/.test(f) && !f.endsWith('.test.ts'));

/**
 * ## Why this file resolves specifiers instead of matching their shape
 *
 * MICA-176. Until this rewrite every check below was anchored on the *text* of a
 * specifier — `(?:\.\./)+(shell|services|nui)/` — which is a guard that stops guarding the
 * moment a specifier changes shape, and says nothing while it does. Two things were already
 * invisible to it:
 *
 * - `sdk/host/useMail.ts`'s `export { unreadMailCount } from '../host/facets/mail'` —
 *   a real value edge from an add-on-reachable file into `services/mail.ts`, three modules
 *   deep. It begins `./`, not `../`, so it never matched, and `inProcess/` was not in the
 *   forbidden list at all. Four hook files had six such edges between them and only
 *   `vite.addon.config.ts`'s `facetSwap()` plugin was keeping them out of an add-on bundle.
 * - Anything reached through a path alias rather than a relative specifier.
 *
 * And MICA-172 will move these files, which changes every `../` count in the tree at
 * once. A check that reads as a pass while guarding nothing is the failure mode AGENTS.md
 * §9 names, so the anchor is now the **resolved location on disk** of what a file imports.
 * That cannot silently stop matching: a specifier either resolves to a file inside a
 * forbidden directory or it does not, however it is spelled and wherever the importer moves
 * to.
 *
 * The second half of the same property is `resolveSpecifier` throwing on a specifier it can
 * neither resolve to a file nor identify as an installed package. Without that, a new alias
 * family — or a moved file — would degrade to "unresolvable, therefore ignored", which is
 * the same fail-open shape wearing a different hat.
 */

/** Where an add-on's bundle has nothing to resolve. Absolute, so the check is positional. */
const FORBIDDEN_DIRS = [
  join(SRC, 'shell'),
  join(SRC, 'services'),
  join(SRC, 'nui'),
  /**
   * `host/facets/` joins the list in MICA-176. It is the shell-backed half
   * of the host seam — 46 of its 48 modules import `shell/`, `services/` or `nui/` by value
   * — and since `facetSwap()` was deleted nothing rewrites a path into it. An add-on's entry
   * imports `sdk/host/iframe/registerFacets` and the shell's imports
   * `host/registerFacets`, so a file on the add-on graph naming a facet by
   * value is now a real edge rather than one a resolver plugin will redirect. Type-only
   * references are still fine and are why `iframe/facets/*.ts` may write
   * `typeof import('../host/facets/mail')`: erased at build time, never resolved.
   *
   * `facets/`, not the whole of `inProcess/`. Its three other modules — `system.ts`,
   * `createInProcessHost.ts`, `settingsSync.ts` — are not classified by where they sit: the
   * first two are deliberately shell-free (that is what makes `guard.ts` safe to import from
   * module scope, and `iframe/boot.ts` builds its own host out of `createInProcessHost`), and
   * whether the third is reachable is answered by the transitive walk rather than by a
   * directory blanket. A directory ban here would have been the shape-matching mistake this
   * rewrite exists to stop, one level up.
   */
  join(SRC, 'host')
];

const inForbiddenDir = (file: string) =>
  FORBIDDEN_DIRS.some((dir) => file === dir || file.startsWith(dir + '/'));

/**
 * Specifiers `vite.addon.config.ts` redirects before rollup ever resolves them, so the file
 * named on disk is not the file an add-on bundle contains (MICA-28). Kept in lockstep with
 * that config by hand: nothing here parses it. The facet swap used to be a third entry and
 * is gone — MICA-176 deleted the plugin, so `inProcess/facets/*` now means what it says.
 */
const ALIASED_SPECIFIERS = [/(^|\/)shell\/state\/time$/, /(^|\/)nui\/fetchNui$/];

/** Path aliases both tsconfig and the Vite configs define. Resolved, not skipped. */
const PATH_ALIASES: [RegExp, string][] = [
  [/^@shared\/(.+)$/, join(ROOT, 'shared', '$1')],
  [/^@gphone\/sdk\/app$/, join(SDK, 'app.ts')],
  [/^@gphone\/sdk\/core$/, join(SDK, 'core.ts')],
  [/^@gphone\/sdk\/testing$/, join(SDK, 'testing.ts')],
  [/^@gphone\/sdk$/, join(SDK, 'index.ts')]
];

const asFile = (base: string): string | null => {
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.svelte`,
    `${base}.svelte.ts`,
    join(base, 'index.ts')
  ]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // try the next candidate
    }
  }
  return null;
};

/** An installed package rather than something in this repo — nothing here to check. */
const isInstalledPackage = (specifier: string): boolean => {
  const parts = specifier.split('/');
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  return [join(WEB, 'node_modules', name), join(ROOT, 'node_modules', name)].some(existsSync);
};

/**
 * A specifier's real location on disk, or `null` for an installed package.
 *
 * **Throws** on anything that is neither. That is the point: this file's guarantee is that
 * every edge it walks was actually classified, so "I could not work out what this is" has to
 * be a failure rather than a shrug. See this section's doc comment above.
 */
const resolveSpecifier = (fromFile: string, specifier: string): string | null => {
  if (specifier.startsWith('.')) {
    const resolved = asFile(join(fromFile, '..', specifier));
    if (resolved) return resolved;
    throw new Error(
      `[seam.test] ${relative(ROOT, fromFile)} imports '${specifier}', which resolves to no file. ` +
        `Every check in this file is anchored on where a specifier lands, so an unresolvable ` +
        `one has to fail rather than be skipped.`
    );
  }
  for (const [pattern, target] of PATH_ALIASES) {
    const m = pattern.exec(specifier);
    if (!m) continue;
    const resolved = asFile(target.replace('$1', m[1] ?? ''));
    if (resolved) return resolved;
    throw new Error(
      `[seam.test] ${relative(ROOT, fromFile)} imports '${specifier}' through a path alias that ` +
        `resolves to no file.`
    );
  }
  if (isInstalledPackage(specifier)) return null;
  throw new Error(
    `[seam.test] ${relative(ROOT, fromFile)} imports '${specifier}', which is neither relative, ` +
      `nor a known path alias, nor an installed package. Add it to PATH_ALIASES if this repo ` +
      `defines it — leaving it unclassified would make this whole file quietly stop guarding.`
  );
};

/**
 * A *value* import or re-export, at any depth and however spelled. `import type` and
 * `export type` are excluded: both are erased at build time and so never have to resolve
 * inside an add-on's bundle — `types.ts` re-exports `UIConversation` from
 * `services/conversations` that way, and every `iframe/facets/*.ts` names its inProcess twin
 * in type position to derive the twin's shape.
 */
const VALUE_IMPORT = /^\s*import\s+(?!type\s)[^;]*?from\s+['"]([^'"]+)['"]/gm;
const VALUE_EXPORT = /^\s*export\s+(?!type\s)(?:\{[^}]*\}|\*)\s*from\s+['"]([^'"]+)['"]/gm;
/** A bare side-effect import — `import './registerFacets';`. It has no clause to match above. */
const SIDE_EFFECT_IMPORT = /^\s*import\s+['"]([^'"]+)['"]\s*;?\s*$/gm;

const valueSpecifiers = (file: string): string[] => {
  const text = readFileSync(file, 'utf8');
  const specs: string[] = [];
  for (const rx of [VALUE_IMPORT, VALUE_EXPORT, SIDE_EFFECT_IMPORT]) {
    for (const match of text.matchAll(rx)) specs.push(match[1]);
  }
  return specs;
};

/** Every value edge out of one file that lands inside a forbidden directory. */
const findOffenders = (file: string, exempt: RegExp[] = []): string[] =>
  valueSpecifiers(file)
    .filter((s) => !exempt.some((e) => e.test(s)))
    .filter((s) => {
      const resolved = resolveSpecifier(file, s);
      return resolved !== null && inForbiddenDir(resolved);
    })
    .map(
      (s) => `${relative(ROOT, file)}  ->  ${s}  (${relative(ROOT, resolveSpecifier(file, s)!)})`
    );

/**
 * Every file reachable from `entryFiles` by following value edges (MICA-28). This is what
 * catches a new `web/src/lib/` file that a kit or iframe file starts importing: `lib/`
 * carries no directory-level check of its own (AGENTS.md §8 — it's plain helpers,
 * legitimately reachable from an add-on bundle), so the only thing that can catch it
 * reaching into `shell/` is following the import graph out to wherever it actually leads.
 *
 * An `ALIASED_SPECIFIERS` edge is not followed: the file it names on disk is not the file an
 * add-on bundle contains. A forbidden edge is not followed either — it is reported by the
 * caller, and walking into it would report the same shell tree from every entry.
 */
const transitiveReachable = (entryFiles: string[], exempt: RegExp[] = []): string[] => {
  const seen = new Set<string>();
  const queue = [...entryFiles];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of valueSpecifiers(file)) {
      if (exempt.some((e) => e.test(specifier))) continue;
      const resolved = resolveSpecifier(file, specifier);
      if (resolved && !inForbiddenDir(resolved) && !seen.has(resolved)) queue.push(resolved);
    }
  }
  return [...seen];
};

describe('the kit does not reach the shell', () => {
  it('finds kit files to check', () => {
    expect(FILES.length).toBeGreaterThan(20);
  });

  it('no kit file, or anything it transitively imports, value-imports or value-re-exports shell/, services/, nui/ or sdk/host/inProcess/', () => {
    const offenders = transitiveReachable(FILES, ALIASED_SPECIFIERS).flatMap((f) =>
      findOffenders(f, ALIASED_SPECIFIERS)
    );
    expect(
      offenders.sort(),
      'go through a host hook (sdk/host/) instead — an add-on bundle has no shell to import'
    ).toEqual([]);
  });
});

/**
 * The host hooks themselves may not reach the shell either.
 *
 * `sdk/host/*.ts` and `sdk/host/*.svelte.ts` (excluding `sdk/host/inProcess/**`) are the
 * thin `guarded('useX').facets.x(...)` wrappers (MICA-16 step 3) — they resolve a `Host`
 * and delegate. The bodies that actually reach `shell/`, `services/` and `nui/` live under
 * `host/facets/`, which is the one place in the host API allowed to import
 * them.
 *
 * MICA-176 makes this sharper than it was. A hook may no longer name a concrete facet
 * module *at all* — not `./inProcess/facets/contacts` for its side effect, and not
 * `export { unreadMailCount } from '../host/facets/mail'` for a value, which is what
 * four of them were doing. Which facet set a bundle contains is now decided by its entry
 * point (`src/main.ts` or `bootAddOn`), and a hook that names one takes that decision back.
 */

const HOST_DIR = join(SDK, 'host');
const HOST_IN_PROCESS = join(HOST_DIR, 'inProcess');

const hostFiles = walk(HOST_DIR).filter(
  (f) =>
    /\.(svelte\.ts|ts)$/.test(f) && !f.endsWith('.test.ts') && !f.startsWith(HOST_IN_PROCESS + '/')
);

describe('the host hooks do not reach the shell', () => {
  it('finds host hook files to check', () => {
    expect(hostFiles.length).toBeGreaterThan(20);
  });

  it('no sdk/host file (outside inProcess/) value-imports or value-re-exports shell/, services/, nui/ or inProcess/', () => {
    const offenders = hostFiles
      .filter((f) => f !== join(HOST_DIR, 'iframe', 'registerFacets.ts'))
      .flatMap((f) => findOffenders(f));
    expect(
      offenders.sort(),
      'move the import into host/facets/ — a hook file only resolves a Host and delegates'
    ).toEqual([]);
  });
});

/**
 * The iframe transport (and the add-on barrel built on it) may not reach the shell either.
 *
 * Once add-ons run in a sandboxed iframe, `sdk/host/iframe/**` and `sdk/addon.ts` are the
 * only things in an add-on's JS context — the transport, the twins it builds facets from,
 * and boot. Any of them reaching `shell/`, `services/` or `nui/` by value is a thing that
 * cannot resolve inside an add-on's own bundle.
 *
 * Since MICA-176 this is also the check that replaces `facetSwap()`. `addon.ts` is a real
 * entry point of the add-on build, so walking it transitively is walking what a bundle
 * actually contains — and `sdk/host/inProcess/` being a forbidden directory is what proves
 * the sandboxed half no longer depends on a resolver plugin's regex to stay out.
 */

const IFRAME_DIR = join(HOST_DIR, 'iframe');

const iframeFiles = walk(IFRAME_DIR)
  .filter((f) => /\.(svelte\.ts|ts)$/.test(f) && !f.endsWith('.test.ts'))
  .concat(join(SDK, 'addon.ts'));

const ADDON_FILE = join(SDK, 'addon.ts');

/**
 * The only two `services/` re-exports `sdk/addon.ts` is allowed to keep — everything else
 * it exports from `shell/`, `services/` or `nui/` is a bug, never a case to widen this for.
 * Both cross the seam on purpose: `createCrudStore`/`createPagedStore`'s own `nui/fetchNui`
 * import is swapped for the add-on build's transport-backed fetch at bundle time, so the
 * two names themselves are safe to hand an add-on even though their module lives in
 * `services/` (MICA-16 step 4).
 */
const ADDON_ALLOWED_SPECIFIERS = ['../services/createCrudStore', '../services/createPagedStore'];

const addonExempt = (file: string, specifier: string) =>
  (file === ADDON_FILE && ADDON_ALLOWED_SPECIFIERS.includes(specifier)) ||
  ALIASED_SPECIFIERS.some((e) => e.test(specifier));

const iframeOffenders = (file: string): string[] =>
  valueSpecifiers(file)
    .filter((s) => !addonExempt(file, s))
    .filter((s) => {
      const resolved = resolveSpecifier(file, s);
      return resolved !== null && inForbiddenDir(resolved);
    })
    .map((s) => `${relative(ROOT, file)}  ->  ${s}`);

const addonReachable = () => {
  const seen = new Set<string>();
  const queue = [...iframeFiles];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of valueSpecifiers(file)) {
      if (addonExempt(file, specifier)) continue;
      const resolved = resolveSpecifier(file, specifier);
      if (resolved && !inForbiddenDir(resolved) && !seen.has(resolved)) queue.push(resolved);
    }
  }
  return [...seen];
};

describe('the iframe transport and the add-on barrel do not reach the shell', () => {
  it('finds iframe files to check', () => {
    expect(iframeFiles.length).toBeGreaterThan(20);
  });

  it('no sdk/host/iframe file, sdk/addon.ts, or anything either transitively imports, value-imports or value-re-exports shell/, services/, nui/ or sdk/host/inProcess/ (outside the addon.ts allowlist)', () => {
    const offenders = addonReachable().flatMap(iframeOffenders);
    expect(
      offenders.sort(),
      'an add-on bundle has no shell to import — go through the transport instead'
    ).toEqual([]);
  });
});

/**
 * Every in-process facet has an iframe twin, and both boot sets are exhaustive.
 *
 * `host/facets/*.ts` is what a hook resolves to inside the shell; once an
 * add-on runs in its own iframe, the same hook must resolve to a twin under
 * `sdk/host/iframe/facets/` that goes over the transport instead. A facet added to one side
 * and forgotten on the other is a hook that silently works in-process and throws (or worse,
 * no-ops) once the app it belongs to actually ships as a sandboxed add-on.
 *
 * MICA-176 adds the second half. A facet is now pulled onto the graph by
 * `<side>/registerFacets.ts` rather than by the hook that uses it, so a facet file that
 * exists, has a twin, and is in neither boot set never registers — and the first thing that
 * notices is `host facet 'x' is not loaded`, thrown at whoever opens that app. The list in
 * each `registerFacets.ts` is compared against the directory here so that a facet added and
 * not listed fails the suite instead.
 */

const IN_PROCESS_FACETS = join(SRC, 'host', 'facets');
const IFRAME_FACETS = join(IFRAME_DIR, 'facets');

const facetNames = (dir: string, exclude: string[]): string[] =>
  readdirSync(dir)
    .filter((f) => f.endsWith('.ts') || f.endsWith('.svelte.ts'))
    .filter((f) => !f.endsWith('.test.ts') && !exclude.includes(f))
    .sort();

/** The `./facets/<name>` specifiers one `registerFacets.ts` imports, as file names. */
const bootSet = (registerFacetsFile: string): string[] =>
  valueSpecifiers(registerFacetsFile)
    .filter((s) => s.startsWith('./facets/'))
    .map((s) => `${s.slice('./facets/'.length)}.ts`)
    .sort();

describe('every in-process facet has an iframe twin', () => {
  it('sdk/host/iframe/facets/*.ts file names equal web/src/host/facets/*.ts file names', () => {
    const inProcess = facetNames(IN_PROCESS_FACETS, ['index.ts']);
    const iframe = facetNames(IFRAME_FACETS, ['_shared.ts']);
    expect(inProcess.length).toBeGreaterThan(20);
    expect(iframe).toEqual(inProcess);
  });
});

describe('the boot facet sets are exhaustive', () => {
  it('host/registerFacets.ts imports every in-process facet', () => {
    expect(bootSet(join(SRC, 'host', 'registerFacets.ts'))).toEqual(
      facetNames(IN_PROCESS_FACETS, ['index.ts'])
    );
  });

  it('sdk/host/iframe/registerFacets.ts imports every iframe twin', () => {
    expect(bootSet(join(IFRAME_DIR, 'registerFacets.ts'))).toEqual(
      facetNames(IFRAME_FACETS, ['_shared.ts'])
    );
  });

  /**
   * The in-process set is imported by exactly one module, and it is the shell's entry.
   * Anything else importing it — a hook, `guard.ts`, or anything either of those reaches —
   * puts `shell/` back on the module graph between `guard.ts` and the state it reads, which
   * is the cycle `current.ts`'s type-only facet import exists to avoid, and would also make
   * the whole seam moot by dragging the shell-backed facets into an add-on bundle.
   */
  it('only an entry point imports the in-process facet set', () => {
    const target = join(SRC, 'host', 'registerFacets.ts');
    /**
     * Two entry points, and nothing else. `main.ts` is the shell's boot path; `testing.ts`
     * backs `@gphone/sdk/testing` and stands in for the shell in a unit test.
     *
     * `sdk/index.ts` was on this list until MICA-172 and is deliberately off it now: the
     * in-process facets live in `web/src/host/`, so the SDK importing them would be a package
     * importing its consumer, which is the edge this whole ticket removes. A test file that
     * needs the set says so itself, and is excluded below.
     */
    const allowed = new Set([join(SRC, 'main.ts'), join(SRC, 'testing.ts')]);
    const importers = walk(SRC)
      .filter((f) => /\.(svelte|svelte\.ts|ts)$/.test(f) && !f.endsWith('.test.ts'))
      .filter((f) => !allowed.has(f))
      .filter((f) =>
        valueSpecifiers(f).some((s) => {
          if (!s.startsWith('.')) return false;
          try {
            return resolveSpecifier(f, s) === target;
          } catch {
            return false;
          }
        })
      )
      .map((f) => relative(ROOT, f));
    expect(
      importers.sort(),
      'the shell entry point picks the facet set — nothing else may, or the choice is back in the module graph'
    ).toEqual([]);
  });
});
