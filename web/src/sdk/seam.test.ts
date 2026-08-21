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

describe('the kit does not reach the shell', () => {
  it('finds kit files to check', () => {
    expect(FILES.length).toBeGreaterThan(20);
  });

  it('no kit file value-imports shell/, services/ or nui/', () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(VALUE_IMPORT)) {
        offenders.push(`${relative(ROOT, file)}  ->  ${match[0].trim()}`);
      }
    }
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

  it('no sdk/host file (outside inProcess/) value-imports shell/, services/ or nui/', () => {
    const offenders: string[] = [];
    for (const file of hostFiles) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(VALUE_IMPORT)) {
        offenders.push(`${relative(ROOT, file)}  ->  ${match[0].trim()}`);
      }
    }
    expect(
      offenders.sort(),
      'move the import into sdk/host/inProcess/facets/ — a hook file only resolves a Host and delegates'
    ).toEqual([]);
  });
});
