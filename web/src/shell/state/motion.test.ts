// @vitest-environment jsdom
/**
 * MICA-176: which facet set this file's subject resolves against. A hook no longer
 * carries its facet — `src/main.ts` picks the in-process set for the shell and `bootAddOn`
 * picks the iframe twins for an add-on — so a test file, having neither entry point, says
 * which side it is standing in for. In-process, because a unit test stands in for the shell.
 */
import '../../host/registerFacets';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { get } from 'svelte/store';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * MICA-66.
 *
 * What is worth asserting here is the *resolution rule* — how a stored preference and the
 * platform's answer combine — because that is the decision the rest of the phone hangs
 * off, and it is pure logic that jsdom can model faithfully.
 *
 * What is deliberately **not** asserted is that anything actually stops moving. jsdom
 * computes no layout, runs no animations and evaluates no media queries, so a test
 * claiming "the drawer does not slide" would be measuring a stub. The stylesheet half of
 * this feature (`app.css`) is verified by reading it, and in game by watching the phone.
 *
 * The media query is stubbed rather than trusted for the same reason: jsdom's
 * `matchMedia` parses the string and reports `matches: false` for everything, so a test
 * that did not stub it would pass for the wrong reason and would keep passing if the
 * store stopped consulting the query at all.
 */

interface FakeMql {
  matches: boolean;
  media: string;
  listeners: Set<(event: MediaQueryListEvent) => void>;
  addEventListener: (type: string, fn: (event: MediaQueryListEvent) => void) => void;
  removeEventListener: (type: string, fn: (event: MediaQueryListEvent) => void) => void;
  /** Drives a change the way the platform would. */
  emit: (matches: boolean) => void;
}

const fakeMql = (matches: boolean): FakeMql => {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const mql: FakeMql = {
    matches,
    media: '',
    listeners,
    addEventListener: (_type, fn) => listeners.add(fn),
    removeEventListener: (_type, fn) => listeners.delete(fn),
    emit: (next) => {
      mql.matches = next;
      for (const fn of listeners) fn({ matches: next } as MediaQueryListEvent);
    }
  };
  return mql;
};

/**
 * A fresh module graph per case. `systemPrefersReducedMotion`'s initial value is read at
 * import time, so the stub has to be installed before the import rather than around it.
 */
const load = async (systemAsksForReduce: boolean) => {
  vi.resetModules();
  /**
   * MICA-176. `vi.resetModules()` throws away the module registry, `sdk/host/current.ts`
   * included — so the facet registry this file populated with its top-level
   * `registerFacets` import is gone, and the *fresh* `current.ts` the re-imports below get
   * has an empty one. Re-importing the set here is what repopulates it; without this line
   * the first hook call after a reset throws `host facet '<name>' is not loaded`.
   */
  await import('../../host/registerFacets');
  const mql = fakeMql(systemAsksForReduce);
  const matchMedia = vi.fn((media: string) => {
    mql.media = media;
    return mql as unknown as MediaQueryList;
  });
  vi.stubGlobal('matchMedia', matchMedia);
  const mod = await import('./motion');
  return { mod, mql, matchMedia };
};

describe('reduced motion', () => {
  beforeEach(() => {
    // Vitest's jsdom environment does not hand out a bare `localStorage` global, and
    // `usePersisted` reaches it through `window` anyway.
    window.localStorage?.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('asks the platform for prefers-reduced-motion, and only that', async () => {
    const { mod, matchMedia } = await load(false);
    // Subscribing is what starts the listener; `get` does both.
    get(mod.systemPrefersReducedMotion);
    expect(matchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)');
    expect(mod.REDUCED_MOTION_QUERY).toBe('(prefers-reduced-motion: reduce)');
  });

  it('follows the platform by default', async () => {
    const { mod } = await load(true);
    expect(get(mod.motionPreference)).toBe('system');
    expect(get(mod.reducedMotion)).toBe(true);
  });

  it('leaves motion on when the platform asks for nothing', async () => {
    const { mod } = await load(false);
    expect(get(mod.reducedMotion)).toBe(false);
  });

  it('lets the player turn motion down on a platform that never asked', async () => {
    const { mod } = await load(false);
    mod.setMotionPreference('reduced');
    expect(get(mod.reducedMotion)).toBe(true);
  });

  /**
   * The case that decides where the media query may be read. A bare
   * `@media (prefers-reduced-motion: reduce)` block in the stylesheet would answer `true`
   * here regardless of what this store says, which is why `app.css` has none.
   */
  it('lets the player keep motion on a platform that asks to reduce it', async () => {
    const { mod } = await load(true);
    mod.setMotionPreference('full');
    expect(get(mod.reducedMotion)).toBe(false);
  });

  it('follows the platform changing mid-session while on system', async () => {
    const { mod, mql } = await load(false);
    const seen: boolean[] = [];
    const stop = mod.reducedMotion.subscribe((v) => seen.push(v));

    mql.emit(true);
    expect(get(mod.reducedMotion)).toBe(true);
    mql.emit(false);
    expect(get(mod.reducedMotion)).toBe(false);

    stop();
    expect(seen).toEqual([false, true, false]);
  });

  it('ignores the platform changing once the player has chosen', async () => {
    const { mod, mql } = await load(false);
    mod.setMotionPreference('full');
    const stop = mod.reducedMotion.subscribe(() => {});

    mql.emit(true);
    expect(get(mod.reducedMotion)).toBe(false);
    stop();
  });

  it('drops the listener when nothing is watching', async () => {
    const { mod, mql } = await load(false);
    const stop = mod.reducedMotion.subscribe(() => {});
    expect(mql.listeners.size).toBe(1);
    stop();
    expect(mql.listeners.size).toBe(0);
  });

  it('falls back to the default rather than throwing on a hand-edited value', async () => {
    const { mod } = await load(false);
    expect(mod.sanitizeMotionPreference('sideways')).toBe('system');
    expect(mod.sanitizeMotionPreference(undefined)).toBe('system');
    expect(mod.sanitizeMotionPreference('reduced')).toBe('reduced');
  });

  it('publishes the answer to the document, and keeps it current', async () => {
    const { mod, mql } = await load(false);
    const stop = mod.observeReducedMotion();

    // The attribute is what `app.css` selects on and what `lib/motion.ts` reads, so this
    // is the whole contract between the store and both halves of the feature.
    expect(document.documentElement.dataset.reducedMotion).toBe('false');

    mod.setMotionPreference('reduced');
    expect(document.documentElement.dataset.reducedMotion).toBe('true');

    mod.setMotionPreference('system');
    mql.emit(true);
    expect(document.documentElement.dataset.reducedMotion).toBe('true');

    stop();
  });

  it('survives a host with no matchMedia at all', async () => {
    vi.resetModules();
    // MICA-176: `resetModules` discarded the facet registry — see `motion.test.ts`'s note.
    await import('../../host/registerFacets');
    vi.stubGlobal('matchMedia', undefined);
    const mod = await import('./motion');
    expect(get(mod.systemPrefersReducedMotion)).toBe(false);
    expect(get(mod.reducedMotion)).toBe(false);
    mod.setMotionPreference('reduced');
    expect(get(mod.reducedMotion)).toBe(true);
  });
});

/**
 * The design decision, held in place.
 *
 * Nothing above can catch a second reader of `prefers-reduced-motion` appearing later —
 * a `@media` block dropped into a stylesheet, or a component asking `matchMedia` itself —
 * and a second reader is exactly the failure this feature was designed around: it would
 * override the player who explicitly chose to keep their animations, silently and with
 * nothing in the UI to explain it. So the rule is enforced by reading the source.
 */
describe('one reader of the media query', () => {
  const ROOT = join(__dirname, '..', '..');

  const walk = (dir: string): string[] => {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...walk(full));
      else if (/\.(svelte|ts|css)$/.test(entry)) out.push(full);
    }
    return out;
  };

  const FILES = walk(ROOT);

  it('finds the tree to scan', () => {
    expect(FILES.length).toBeGreaterThan(100);
  });

  it('is asked in exactly one module', () => {
    // Naming the query in prose is fine and several files do; *asking* it is the thing
    // that may only happen once, so this looks for the two ways a file can ask —
    // `matchMedia` in script, an `@media` at-rule in a stylesheet.
    // Comments are stripped first, and that is not fastidiousness: the note in `app.css`
    // explaining why there is no `@media (prefers-reduced-motion)` block quotes the very
    // string this looks for, and tripped the rule it documents.
    const code = (text: string) =>
      text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    const readers = FILES.filter((file) => {
      if (file.endsWith('motion.test.ts')) return false;
      const text = code(readFileSync(file, 'utf8'));
      return text.includes('matchMedia(') || text.includes('@media (prefers-reduced-motion');
    }).map((file) => relative(ROOT, file));

    expect(readers).toEqual([join('shell', 'state', 'motion.ts')]);
  });

  /**
   * The other half. A Svelte 5 `transition:` runs on the Web Animations API and takes its
   * duration from a JavaScript object, so the stylesheet above cannot touch it — a call
   * site that imports `svelte/transition` directly is silently exempt from the player's
   * setting, and looks completely correct while being so. This is the only thing that
   * catches that, and it is why the wrappers exist.
   */
  it('is the only module importing svelte/transition', () => {
    const importers = FILES.filter((file) => {
      // `lib/motion.ts` is the wrapper; this rule exists to send everything else there.
      if (/motion(\.test)?\.ts$/.test(file)) return false;
      return /from 'svelte\/transition'/.test(readFileSync(file, 'utf8'));
    }).map((file) => relative(ROOT, file));

    expect(importers).toEqual([]);
  });

  it('is acted on by exactly one stylesheet rule, keyed on the attribute the store writes', () => {
    const css = readFileSync(join(ROOT, 'app.css'), 'utf8');

    expect(css).toContain("html[data-reduced-motion='true'] *");
    expect(css).toContain('animation-duration: 1ms !important');
    expect(css).toContain('transition-duration: 1ms !important');

    // A frozen loading spinner reads as a hang; it is the one loop that stays.
    expect(css).toContain("html[data-reduced-motion='true'] .animate-spin");
  });
});
