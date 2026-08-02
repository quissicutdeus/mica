import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Apps may not reach past the SDK.
 *
 * §2.7 has said so since the SDK existed, and it drifted anyway: nine UI components,
 * thirty-two icons, fifteen utility imports and one store were all being pulled in by
 * relative path. Nothing checked, so nothing stopped it.
 *
 * It matters for one concrete reason. An add-on installed through the Store resolves
 * `@gphone/sdk` and nothing else — `../../sdk/ui/Screen.svelte` does not exist for it.
 * Every relative import out of an app is a thing a third-party app cannot do, which
 * quietly makes the app-registry story only half true.
 *
 * A prose rule that is not enforced is a suggestion. This is the enforcement.
 */

const ROOT = join(__dirname, '..', '..');
const APPS = join(ROOT, 'src', 'apps');

/**
 * Directories an app must never import from by path — everything outside itself.
 *
 * Kept as an explicit list rather than "anything that escapes", so a new top-level
 * directory has to be classified deliberately instead of silently becoming reachable.
 */
const FORBIDDEN = ['shell', 'services', 'sdk', 'nui', 'lib'];

/**
 * `../../sdk` is a violation too, and the directory pattern above missed it: it requires
 * a `/` after the directory name, and the SDK barrel is imported as the bare directory.
 * Photos had both forms in one file and only the tidy one was caught.
 */
const BARE_SDK_IMPORT = /from\s+['"](?:\.\.\/)+sdk['"]/g;

const walk = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(svelte|ts)$/.test(entry) && !entry.endsWith('.test.ts')) out.push(full);
  }
  return out;
};

/** `import ... from '../../<forbidden dir>/...'`, at any depth. */
const ESCAPING_IMPORT = new RegExp(
  String.raw`from\s+['"](?:\.\./)+(${FORBIDDEN.join('|')})/[^'"]*['"]`,
  'g'
);

const FILES = walk(APPS);

describe('app boundary', () => {
  it('finds apps to check', () => {
    // A walk that silently matched nothing would make the rule below vacuous.
    expect(FILES.length).toBeGreaterThan(10);
  });

  it('no app imports past the SDK by relative path', () => {
    const offenders: string[] = [];

    for (const file of FILES) {
      const text = readFileSync(file, 'utf8');
      for (const match of [...text.matchAll(ESCAPING_IMPORT), ...text.matchAll(BARE_SDK_IMPORT)]) {
        offenders.push(`${relative(ROOT, file)}  ->  ${match[0].replace(/^from\s+/, '')}`);
      }
    }

    expect(
      offenders.sort(),
      'export it from @gphone/sdk instead — an add-on cannot resolve a relative shell path'
    ).toEqual([]);
  });

  it('the SDK actually re-exports what apps were reaching for', async () => {
    // Guards the other direction: the rule above is only satisfiable if the surface
    // exists. A missing export would push the next author back to a relative import.
    const sdk = await import('./index');

    for (const name of [
      // Components
      'Screen',
      'ListItem',
      'Button',
      'Avatar',
      'SearchBar',
      'EmptyState',
      'ConfirmDialog',
      'FloatingActionButton',
      'PhotoPickerModal',
      // Written, then left out of the barrel, so apps inlined their own instead.
      'SegmentedControl',
      'ToggleSwitch',
      'Skeleton',
      // Utils
      'isBrowser',
      'formatDate',
      'formatRelativeTime',
      'formatCurrency',
      'renderMarkdown',
      'useScrollDetect',
      'filterByQuery',
      // Hooks
      'useNavigation',
      'useKeybinds',
      'useDevTools',
      // Icons are generated; spot-check one that was imported by path before.
      'ChevronRightIcon'
    ]) {
      expect(sdk, `@gphone/sdk is missing ${name}`).toHaveProperty(name);
    }
    // Importing the barrel compiles every icon and component in the SDK — real work
    // that grew past the 5s default as the surface grew, and timed out rather than
    // failing on an assertion.
  }, 30_000);

  it('does not export the shell itself', async () => {
    // An app rendering its own phone frame or toast host is a bug. Exporting these
    // would make that easy and look sanctioned.
    //
    // Asserted against the resolved module rather than the source text: the docblock in
    // `components.ts` names these precisely to explain why they are absent, and a
    // grep for them matched the explanation.
    const sdk = await import('./index');
    for (const shellOnly of [
      'PhoneFrame',
      'ToastContainer',
      'ErrorBoundary',
      'VolumeHud',
      'Home'
    ]) {
      expect(sdk, `@gphone/sdk should not expose ${shellOnly}`).not.toHaveProperty(shellOnly);
    }
  }, 30_000);
});
