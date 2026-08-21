import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
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
const ROOT = join(SDK, '..', '..');

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

/**
 * What a kit file may not import by value. `lib/` is absent on purpose: AGENTS.md §8 defines
 * it as helpers with no gPhone state and no I/O, which is exactly what can be bundled.
 */
const SHELL_ONLY = ['shell', 'services', 'nui'];

const walk = (path: string): string[] => {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path).flatMap((entry) => walk(join(path, entry)));
};

const FILES = KIT.flatMap(walk).filter((f) => /\.(svelte|ts)$/.test(f) && !f.endsWith('.test.ts'));

/**
 * A value import of a shell-only directory, at any relative depth. `import type` is allowed:
 * it is erased at build time and so never has to resolve inside an add-on's bundle —
 * `types.ts` re-exports `UIConversation` from `services/conversations` that way.
 */
const VALUE_IMPORT = new RegExp(
  String.raw`^\s*import\s+(?!type\s)[^;]*?from\s+['"](?:\.\./)+(${SHELL_ONLY.join('|')})/[^'"]*['"]`,
  'gm'
);

/**
 * A value *re-export* of a shell-only directory — `export { a, b } from '...'` or
 * `export * from '...'` — at any relative depth. `import type` has a re-export twin,
 * `export type { ... } from`, which is excluded the same way: it is erased at build time.
 * Without this, `export { toast } from '../shell/state/toast'` inside `sdk/addon.ts` would
 * sail past `VALUE_IMPORT` (anchored on the `import` keyword) while still being exactly
 * the thing this file exists to catch — a name an add-on's bundle has nothing to resolve.
 */
const VALUE_EXPORT = new RegExp(
  String.raw`^\s*export\s+(?!type\s)(?:\{[^}]*\}|\*)\s*from\s+['"](?:\.\./)+(${SHELL_ONLY.join('|')})/[^'"]*['"]`,
  'gm'
);

/** Every `VALUE_IMPORT`/`VALUE_EXPORT` hit in one file, formatted the way every describe below reports it. */
const findOffenders = (file: string): string[] => {
  const text = readFileSync(file, 'utf8');
  const offenders: string[] = [];
  for (const rx of [VALUE_IMPORT, VALUE_EXPORT]) {
    for (const match of text.matchAll(rx)) {
      offenders.push(`${relative(ROOT, file)}  ->  ${match[0].trim()}`);
    }
  }
  return offenders;
};

describe('the kit does not reach the shell', () => {
  it('finds kit files to check', () => {
    expect(FILES.length).toBeGreaterThan(20);
  });

  it('no kit file value-imports or value-re-exports shell/, services/ or nui/', () => {
    const offenders = FILES.flatMap(findOffenders);
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
 * and delegate. The old bodies that actually reach `shell/`, `services/` and `nui/` now
 * live under `sdk/host/inProcess/facets/`, which is the one place in the host API allowed
 * to import them. A hook file that kept a shell import instead of moving it into its facet
 * would defeat the whole point of the protocol: there would be nothing to swap out when
 * add-ons stop sharing the shell's JS context.
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

  it('no sdk/host file (outside inProcess/) value-imports or value-re-exports shell/, services/ or nui/', () => {
    const offenders = hostFiles.flatMap(findOffenders);
    expect(
      offenders.sort(),
      'move the import into sdk/host/inProcess/facets/ — a hook file only resolves a Host and delegates'
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

const iframeOffenders = (file: string): string[] => {
  const text = readFileSync(file, 'utf8');
  const offenders: string[] = [];
  for (const rx of [VALUE_IMPORT, VALUE_EXPORT]) {
    for (const match of text.matchAll(rx)) {
      const specifier = match[0].match(/['"]([^'"]+)['"]/)?.[1];
      if (file === ADDON_FILE && specifier && ADDON_ALLOWED_SPECIFIERS.includes(specifier)) {
        continue;
      }
      offenders.push(`${relative(ROOT, file)}  ->  ${match[0].trim()}`);
    }
  }
  return offenders;
};

describe('the iframe transport and the add-on barrel do not reach the shell', () => {
  it('finds iframe files to check', () => {
    expect(iframeFiles.length).toBeGreaterThan(20);
  });

  it('no sdk/host/iframe file or sdk/addon.ts value-imports or value-re-exports shell/, services/ or nui/ (outside the addon.ts allowlist)', () => {
    const offenders = iframeFiles.flatMap(iframeOffenders);
    expect(
      offenders.sort(),
      'an add-on bundle has no shell to import — go through the transport instead'
    ).toEqual([]);
  });
});

/**
 * Every in-process facet has an iframe twin.
 *
 * `sdk/host/inProcess/facets/*.ts` is what a hook resolves to inside the shell; once an
 * add-on runs in its own iframe, the same hook must resolve to a twin under
 * `sdk/host/iframe/facets/` that goes over the transport instead. A facet added to one
 * side and forgotten on the other is a hook that silently works in-process and throws (or
 * worse, no-ops) once the app it belongs to actually ships as a sandboxed add-on.
 */

const IN_PROCESS_FACETS = join(HOST_IN_PROCESS, 'facets');
const IFRAME_FACETS = join(IFRAME_DIR, 'facets');

const facetNames = (dir: string, exclude: string[]): string[] =>
  readdirSync(dir)
    .filter((f) => f.endsWith('.ts') || f.endsWith('.svelte.ts'))
    .filter((f) => !f.endsWith('.test.ts') && !exclude.includes(f))
    .sort();

describe('every in-process facet has an iframe twin', () => {
  it('sdk/host/iframe/facets/*.ts file names equal sdk/host/inProcess/facets/*.ts file names (minus index.ts)', () => {
    const inProcess = facetNames(IN_PROCESS_FACETS, ['index.ts']);
    const iframe = facetNames(IFRAME_FACETS, ['_shared.ts']);
    expect(inProcess.length).toBeGreaterThan(20);
    expect(iframe).toEqual(inProcess);
  });
});
