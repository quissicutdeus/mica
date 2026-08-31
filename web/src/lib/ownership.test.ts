import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

/**
 * Where the SDK's implementation lives, and what may not follow it. MICA-171, MICA-172.
 *
 * MICA-171 split a flat `web/src/lib/` into `lib/sdk/` (owned by `@gphone/sdk`) and
 * `lib/phone/` (owned by the shell), because the SDK's *public* exports were implemented
 * outside `sdk/` — `isBrowser`, `filterByQuery`, the formatters, `renderMarkdown`,
 * `useScrollDetect` and the thumbnail set are re-exported by `sdk/utils.ts`, `fade`/`fly`
 * and `placeholderImage` by the barrels, and seven UI primitives under `sdk/ui/` reached
 * into `lib/` directly. MICA-172 could not move the SDK to a root-level workspace package
 * until that was untangled.
 *
 * MICA-172 then finished the job: the SDK-owned half **moved into the SDK**, from
 * `web/src/lib/sdk/` to `web/src/sdk/lib/`. So the seam this file guards is no longer two
 * sibling directories under `lib/` — it is now:
 *
 * - `web/src/sdk/lib/` — owned by `@gphone/sdk`, and travelling with it out of `web/`. It
 *   must stay bundle-safe and **self-contained**: see rule 4, which is the strong form of
 *   what used to be a list of forbidden directories.
 * - `web/src/lib/` — owned by the shell. Nothing under `web/src/sdk/` may reach it. It
 *   stays in `web/` when the SDK leaves, and `phone/` is the only owner left in it.
 *
 * `lib/phone/` may import the SDK's half (`debug.ts` uses `isBrowser`). The reverse is the
 * violation, and rules 3 and 4 are what make it one.
 *
 * ## The triage, module by module
 *
 * "The SDK imports it today" was the starting point, not the answer — the alternative
 * verdict for anything the SDK reaches is *remove the SDK's use of it*, and that was
 * considered for each. Nothing in the SDK-reached set turned out to be phone-only.
 *
 * **SDK-owned, public surface.** `isBrowser`, `filterByQuery`, `formatters`, `markdown`,
 * `useScrollDetect`, `thumbnail` (re-exported by `sdk/utils.ts`), `motion` (`fade`/`fly`,
 * `sdk/index.ts` + `sdk/addon.ts`), `placeholderImage` (both barrels), `m3` (the `M3Tokens`
 * type, both barrels), `focusTrap` and `errors` (`messageOf`, both promoted onto
 * `sdk/utils.ts` by MICA-172). An add-on resolves these names, so their implementation is
 * SDK-owned by definition.
 *
 * **SDK-owned, not public.** `dominantColor`, `musicErrors`, `musicBroadcast`, `seed`. None
 * is exported from `sdk/index.ts`, `sdk/addon.ts` or `sdk/core.ts`; each is a dependency of
 * something that is. They are SDK-owned because the SDK cannot be moved without them, not
 * because an add-on can name them. `musicBroadcast` and `seed` are the structural case: the
 * iframe facet twins (`sdk/host/iframe/facets/music.ts`, `.../theme.ts`) may import nothing
 * from `shell/`, so the constants and the seed sanitizer were pulled out of `shell/state/`
 * and `m3.ts` precisely so an add-on's bundle could carry them.
 *
 * **`m3.ts` is SDK-owned**, confirmed rather than assumed: it is reached from
 * `sdk/index.ts`, `sdk/addon.ts`, `sdk/ui/NowPlayingCard.svelte`, both theme facets and
 * `sdk/cef.test.ts`, and a decision on MICA-172 puts the design system on the SDK side.
 * `app.css`, `app-utilities.css` and `app-reset.css` moved to `web/src/sdk/` on MICA-172
 * for the same reason: eight files under `shell/` already import `@gphone/sdk`, so an SDK
 * primitive depending on a stylesheet outside the package was a reverse edge — and a
 * primitive that renders unstyled unless the consumer separately remembers a CSS import
 * fails silently, which is the failure mode this repo cares most about.
 *
 * **Phone-owned.** `pointerDrag`, `sheetDrag`, `longPressDrag`, `dragRatio`, `dragScroll`
 * are the shell's gesture plumbing and have no importer in `sdk/`. `debug` is the browser
 * dev harness's event emulator. `semver` answers one question for the Store's update row.
 * `appVisibility` is the launcher/dock/drawer visibility rule. None is reachable from the
 * published contract.
 *
 * ## What this file does not cover
 *
 * `boundary.test.ts` still forbids an app importing `lib/` at all. `seam.test.ts` still
 * walks transitively out of the kit and iframe entries. This file is the ownership question
 * only.
 */

const LIB = __dirname;
const SRC = join(LIB, '..');
const SDK = join(SRC, 'sdk');

/** The SDK-owned half, at its MICA-172 home inside the package it belongs to. */
const SDK_LIB = join(SDK, 'lib');
const PHONE_OWNED = join(LIB, 'phone');

const walk = (path: string): string[] => {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path).flatMap((entry) => walk(join(path, entry)));
};

const isSource = (file: string) => /\.(ts|svelte)$/.test(file) && !file.endsWith('.test.ts');

/**
 * Any quoted specifier, wherever it appears — `import`/`export ... from`, a dynamic
 * `import()`, and a `vi.mock()` path, which is a real edge (`NowPlayingCard.test.ts` mocks
 * `sdk/lib/dominantColor` that way) and is invisible to an `import`-anchored pattern.
 * Matching the quoted form rather than the bare text is what keeps a prose mention of
 * `lib/phone/semver.ts` in a doc comment from failing a rule.
 */
const specifiers = (file: string): string[] =>
  [...readFileSync(file, 'utf8').matchAll(/['"]([^'"\n]*\/[^'"\n]*)['"]/g)].map((m) => m[1]);

describe('the SDK owns its own implementation', () => {
  /**
   * Totality, restated for the post-move layout. A helper dropped at `lib/` root belongs to
   * nobody, and "nobody" resolves in practice to "whoever imports it first" — which is how
   * the SDK ended up implemented outside itself in the first place.
   *
   * `phone` is now the *only* legal directory under `lib/`. That is the load-bearing half:
   * it is what fails if somebody recreates `lib/sdk/`, or opens a third owner, instead of
   * putting an SDK-owned helper in `sdk/lib/` where it now belongs.
   */
  it('web/src/lib is phone-owned throughout, and the SDK half lives in the SDK', () => {
    const entries = readdirSync(LIB);
    const strays = entries.filter((e) => !statSync(join(LIB, e)).isDirectory()).filter(isSource);
    const dirs = entries.filter((e) => statSync(join(LIB, e)).isDirectory());

    expect(strays, 'put it in sdk/lib (the SDK can reach it) or lib/phone (it cannot)').toEqual([]);
    expect(
      dirs.sort(),
      'lib/ is the phone half only — an SDK-owned helper goes in web/src/sdk/lib'
    ).toEqual(['phone']);
    expect(existsSync(SDK_LIB), 'the SDK-owned half moved to web/src/sdk/lib on MICA-172').toBe(
      true
    );
  });

  it('finds modules on both sides to check', () => {
    // Every rule below is a "no offenders" assertion, and each would pass vacuously if its
    // walk turned up nothing.
    expect(walk(SDK_LIB).filter(isSource).length).toBeGreaterThan(10);
    expect(walk(PHONE_OWNED).filter(isSource).length).toBeGreaterThan(5);
  });

  /**
   * The rule the ticket asks for by name: a phone-only module gaining an SDK importer fails
   * the build rather than being caught at review. Test files under `sdk/` are checked too —
   * an SDK suite reaching for `lib/phone` is the same misfiling, one commit earlier.
   *
   * This walks all of `web/src/sdk/`, so it covers `sdk/lib/` as a subset. Rule 4 is the
   * sharper check for that subdirectory specifically.
   */
  it('nothing under web/src/sdk imports lib/phone', () => {
    const offenders = walk(SDK)
      .filter((f) => /\.(ts|svelte)$/.test(f))
      .flatMap((file) =>
        specifiers(file)
          .filter((s) => /(^|\/)lib\/phone\//.test(s))
          .map((s) => `${relative(SRC, file)}  ->  ${s}`)
      )
      .sort();

    expect(
      offenders,
      'move the module to sdk/lib if the SDK genuinely owns it — otherwise drop the import'
    ).toEqual([]);
  });

  /**
   * `sdk/lib/` has to stay bundle-safe, and MICA-172 makes that concrete: this directory
   * leaves `web/` with the package, so a relative specifier that climbs out of `web/src/sdk/`
   * is one that **cannot be spelled at all** once the SDK is a root-level workspace package.
   *
   * So the rule is no longer a blocklist of directory names (`shell`, `services`, `nui`,
   * `apps`). It is the strong form: **resolve every relative specifier and require it to stay
   * inside `web/src/sdk/`.** That subsumes the old list and closes what it missed — a reach
   * into `web/src/host/` or `web/src/lib/phone/` was not in the blocklist and would have
   * passed, and `web/src/host/` is exactly where the shell-backed facets moved on this ticket.
   *
   * **The one documented exemption is gone, and that is the point.** MICA-171 allowed
   * `lib/sdk/formatters.ts` to import `is24Hour` from `shell/state/time` for `formatTime`'s
   * default, patched at build time by `vite.addon.config.ts`'s `shellTimeShim`. Commit 77da14f
   * turned that preference into a real seam: `formatters.ts` now imports `is24HourNow` from
   * `sdk/host/seam/clockPreference`, which is inside the package. The allowlist was verified
   * empty against the source before being deleted rather than assumed dead.
   *
   * Test files are excluded, as they were before. A unit test is its own entry point and says
   * which side it stands in for — `sdk/lib/formatters.test.ts` imports the phone's
   * `host/registerFacets` to stand in for the shell, the same way `sdk/barrelCycle.test.ts`
   * does. That is a statement about the test, not an edge in the shipped package.
   */
  it('nothing under web/src/sdk/lib resolves outside the SDK', () => {
    const offenders = walk(SDK_LIB)
      .filter(isSource)
      .flatMap((file) =>
        specifiers(file)
          .filter((s) => s.startsWith('.'))
          .filter((s) => {
            const target = resolve(dirname(file), s);
            return target !== SDK && !target.startsWith(SDK + sep);
          })
          .map((s) => `${relative(SRC, file)}  ->  ${s}`)
      )
      .sort();

    expect(
      offenders,
      'sdk/lib ships inside @gphone/sdk and leaves web/ with it — a specifier that climbs out ' +
        'of web/src/sdk cannot be spelled once the SDK is its own package. Ask through a host ' +
        'seam or a facet instead.'
    ).toEqual([]);
  });
});
