// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

/**
 * Where the SDK's implementation lives, and what may not follow it. MICA-171, MICA-172,
 * MICA-181.
 *
 * MICA-171 split a flat `web/src/lib/` into `lib/sdk/` (owned by `@mica/sdk`) and
 * `lib/phone/` (owned by the shell), because the SDK's *public* exports were implemented
 * outside `sdk/` — `isBrowser`, `filterByQuery`, the formatters, `renderMarkdown`,
 * `useScrollDetect` and the thumbnail set are re-exported by `sdk/utils.ts`, `fade`/`fly`
 * and `placeholderImage` by the barrels, and seven UI primitives under `sdk/ui/` reached
 * into `lib/` directly. MICA-172 could not move the SDK to a root-level workspace package
 * until that was untangled.
 *
 * MICA-172 then finished the job: the SDK-owned half **moved into the SDK**, from
 * `web/src/lib/sdk/` to `sdk/lib/`. So the seam this file guards is no longer two
 * sibling directories under `lib/` — it is now:
 *
 * - `sdk/lib/` — owned by `@mica/sdk`, and travelling with it out of `web/`. It
 *   must stay bundle-safe and **self-contained**: see rule 4, which is the strong form of
 *   what used to be a list of forbidden directories.
 * - `web/src/lib/` — owned by the shell. Nothing under `sdk/` may reach it. It
 *   stays in `web/` when the SDK leaves, and `phone/` is the only owner left in it.
 *
 * `lib/phone/` may import the SDK's half (`debug.ts` uses `isBrowser`). The reverse is the
 * violation, and rules 3 and 4 are what make it one.
 *
 * MICA-181 added the fifth rule, and it points the other way: **nothing outside the SDK
 * names `sdk/lib/` either.** Rules 3 and 4 are about what the SDK may reach; rule 5 is about
 * what may reach the SDK's private half, which had no rule at all and had accumulated
 * thirteen specifiers across ten files by the time anybody looked.
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
 * **SDK-owned, not public.** `dominantColor`, `musicErrors`, `seed`. None is exported from
 * `sdk/index.ts`, `sdk/addon.ts` or `sdk/core.ts`; each is a dependency of something that
 * is. They are SDK-owned because the SDK cannot be moved without them, not because an add-on
 * can name them. `seed` is the structural case: the iframe theme twin
 * (`sdk/host/iframe/facets/theme.ts`) may import nothing from `shell/`, so the seed
 * sanitizer was pulled out of `m3.ts` precisely so an add-on's bundle could carry it.
 * `musicErrors` is the same shape one level along — three modules under `sdk/` import it,
 * and `MusicError`/`MusicErrorReason` are published from `useMusic.ts` while the functions
 * beneath them are not.
 *
 * **`musicBroadcast` was in that list and is gone (MICA-181)**, because the module was two
 * things: `MAX_AUDIBLE_BROADCASTS`, which `sdk/host/iframe/facets/music.ts` imports and which
 * moved to `sdk/host/seam/music.ts`, and a ranking (`rankAudible`, `joinOffsetSeconds`,
 * `INCUMBENT_MARGIN`) with **no importer under `sdk/` at all**, which moved out to
 * `lib/phone/musicRanking.ts`. "The SDK imports it today" was the test, and half the module
 * failed it.
 *
 * **`m3.ts` is SDK-owned**, confirmed rather than assumed: it is reached from
 * `sdk/index.ts`, `sdk/addon.ts`, `sdk/ui/NowPlayingCard.svelte`, both theme facets and
 * `sdk/cef.test.ts`, and a decision on MICA-172 puts the design system on the SDK side.
 * MICA-181 considered **publishing its generator** — `M3Tokens` is already contract, so
 * the type of a scheme is published while the only way to build one is not, which is not a
 * coherent surface — and measured the cost before doing it: `buildSchemes` on `addon.ts`
 * pulls `@material/material-color-utilities` into every add-on bundle and Rollup does not
 * shake it back out (`hodlr` 192.30 kB to 296.17 kB, `snek` 176.60 kB to 280.48 kB). So the
 * six names go through `sdk/host/seam/theme.ts` instead, which costs no contract and is
 * reversible, and the disclosure stays an open question rather than a side effect.
 * `app.css`, `app-utilities.css` and `app-reset.css` moved to `sdk/` on MICA-172
 * for the same reason: eight files under `shell/` already import `@mica/sdk`, so an SDK
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
 *
 * And rule 5 is a rule about *paths*, not about coupling. It has nothing to say about the
 * phone importing `@mica/sdk` too widely, or about a published name that should never have
 * been published — `publicSurface.test.ts` is the gate for the second of those, and there is
 * no gate for the first.
 */

const LIB = __dirname;
const SRC = join(LIB, '..');
/**
 * MICA-172: `sdk/` is a workspace package at the repo root now, a sibling of `web/`
 * rather than a directory inside it — so this climbs out of `web/src/` to find it. That
 * relocation is the whole point of the rules below: a specifier that cannot be spelled
 * from inside the package is one the package cannot carry when it leaves.
 */
const SDK = resolve(SRC, '..', '..', 'sdk');

/** The SDK-owned half, at its MICA-172 home inside the package it belongs to. */
const SDK_LIB = join(SDK, 'lib');
const PHONE_OWNED = join(LIB, 'phone');

const walk = (path: string): string[] => {
  if (!statSync(path).isDirectory()) return [path];
  // MICA-172: `sdk/` is a workspace package at the repo root now and carries its own
  // `node_modules`. Walking into it would scan every dependency's source.
  return readdirSync(path)
    .filter((entry) => entry !== 'node_modules')
    .flatMap((entry) => walk(join(path, entry)));
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
      'lib/ is the phone half only — an SDK-owned helper goes in sdk/lib'
    ).toEqual(['phone']);
    expect(existsSync(SDK_LIB), 'the SDK-owned half moved to sdk/lib on MICA-172').toBe(true);
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
   * This walks all of `sdk/`, so it covers `sdk/lib/` as a subset. Rule 4 is the
   * sharper check for that subdirectory specifically.
   */
  it('nothing under sdk imports lib/phone', () => {
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
   * leaves `web/` with the package, so a relative specifier that climbs out of `sdk/`
   * is one that **cannot be spelled at all** once the SDK is a root-level workspace package.
   *
   * So the rule is no longer a blocklist of directory names (`shell`, `services`, `nui`,
   * `apps`). It is the strong form: **resolve every relative specifier and require it to stay
   * inside `sdk/`.** That subsumes the old list and closes what it missed — a reach
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
  it('nothing under sdk/lib resolves outside the SDK', () => {
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
      'sdk/lib ships inside @mica/sdk and leaves web/ with it — a specifier that climbs out ' +
        'of sdk cannot be spelled once the SDK is its own package. Ask through a host ' +
        'seam or a facet instead.'
    ).toEqual([]);
  });

  /**
   * Rule 4's mirror, and the half that was missing. MICA-181.
   *
   * Rule 4 stops the SDK reaching *out*. Nothing stopped the phone reaching *in*, and it
   * did: ten specifiers across seven files named `sdk/lib/m3`, `sdk/lib/musicBroadcast` and
   * `sdk/lib/musicErrors` by relative path, plus three more for `placeholderImage`,
   * `isBrowser` and `thumbnail`. Those last three are names `@mica/sdk` genuinely
   * publishes, reached by a private path; the first three were **not exported from the
   * package at any entry point at all**, so the phone was depending on implementation the
   * SDK does not promise to keep.
   *
   * Why that is a rule and not a tidiness preference: `sdk/lib/` is the one directory rule 4
   * requires to be self-contained, because it leaves `web/` with the package. A phone module
   * that names a file in it has written down a dependency the package cannot see and cannot
   * honour — the SDK is free to rename, split or delete anything in there, and would find
   * out from a red build in a directory it does not own. Every legitimate need has a
   * channel, and picking one is the decision this rule forces:
   *
   * - **publish it** on `index.ts`/`addon.ts` if an app should be able to name it. Nothing
   *   took this route on MICA-181, and the reason is worth keeping: it is the only one of
   *   the three that is a one-way door, and for the scheme generator it also turned out to
   *   cost about 21 kB gzipped on every add-on bundle whether or not the add-on names it.
   *   Weigh it, do not default to it.
   * - **route it through `sdk/host/seam/`** if only the phone's half of a facet needs it.
   *   That directory is inside the package, is reached by `web/src/host/facets/` and
   *   `shell/state/display.ts` already, and is in no barrel — so it costs no contract and
   *   is reversible. `describeMusicError`, `reasonForCode` and `MAX_AUDIBLE_BROADCASTS`
   *   went this way (`seam/music.ts`), and so did the scheme generator (`seam/theme.ts`).
   * - **move it back** if the SDK does not import it at all. `rankAudible`,
   *   `joinOffsetSeconds` and `INCUMBENT_MARGIN` had no importer under `sdk/` and are now
   *   `lib/phone/musicRanking.ts`.
   *
   * Note what this deliberately does **not** forbid: `web/` naming the rest of `sdk/` by
   * path. `host/current`, `manifest`, `vocabulary/`, `ui/`, `catalog`, `permissions` and the
   * seam are reached from a hundred-odd places, and that direction is the one that is
   * allowed to exist — `sdk/host/seam/captureZoom.ts` says so in as many words. The phone is
   * the SDK's host. It is `sdk/lib/` specifically that is private.
   *
   * **Test files are exempt, and named rather than pattern-matched**, because the exemption
   * has to stay small to mean anything. The reason it exists at all is structural: `vi.mock`
   * and `vi.doMock` take a module specifier and intercept *that module*, so a suite that
   * needs `isBrowser` to answer `false` has to name `sdk/lib/isBrowser` — mocking the barrel
   * that re-exports it does not intercept the re-export. `theme.test.ts` is the other kind:
   * it asserts against `TOKEN_NAMES`, which stays unpublished on purpose (`version.ts` puts
   * the design system out of contract, and a frozen list of token names would drag it back
   * in). Adding a file here is a decision somebody makes in a diff, which is the point.
   */
  const TEST_ONLY_REACHES = [
    'services/admin.test.ts',
    'services/capabilities.test.ts',
    'services/media.test.ts',
    'shell/state/theme.test.ts'
  ];

  /** Does this specifier name something inside `sdk/lib/`? */
  const reachesSdkLib = (file: string, specifier: string): boolean => {
    if (specifier.startsWith('.')) {
      const target = resolve(dirname(file), specifier);
      return target === SDK_LIB || target.startsWith(SDK_LIB + sep);
    }
    // A non-relative form — an alias, or a bare path somebody added to a tsconfig later.
    // Matched by shape rather than resolved, so a mapping this file has never heard of
    // still trips the rule instead of passing through it.
    return /(^|\/)sdk\/lib\//.test(specifier);
  };

  const sdkLibReaches = (files: string[]): string[] =>
    files
      .flatMap((file) =>
        specifiers(file)
          .filter((s) => reachesSdkLib(file, s))
          .map(() => relative(SRC, file))
      )
      .sort();

  it('this rule can tell a reach into sdk/lib from an ordinary SDK import', () => {
    // The detector, driven with input this repo does not contain. A rule that silently
    // stopped matching would otherwise report an empty offender list and read as a pass —
    // which is the exact failure mode AGENTS.md names.
    const from = join(SRC, 'shell', 'state', 'x.ts');
    expect(reachesSdkLib(from, '../../../../sdk/lib/m3')).toBe(true);
    expect(reachesSdkLib(from, '../../../../sdk/lib/nested/deep')).toBe(true);
    expect(reachesSdkLib(from, '@mica/sdk/lib/m3')).toBe(true);
    // The direction that is allowed to exist, and must not be caught by this.
    expect(reachesSdkLib(from, '../../../../sdk/host/seam/music')).toBe(false);
    expect(reachesSdkLib(from, '../../../../sdk/manifest')).toBe(false);
    expect(reachesSdkLib(from, '@mica/sdk')).toBe(false);
    expect(reachesSdkLib(from, '../../lib/phone/musicRanking')).toBe(false);
  });

  it('nothing in web/src outside a test names sdk/lib', () => {
    const files = walk(SRC).filter(isSource);
    // The walk itself, asserted before anything is compared against it.
    expect(
      files.length,
      'walked web/src and found no source — the rule ran on nothing'
    ).toBeGreaterThan(200);

    expect(
      sdkLibReaches(files),
      'sdk/lib is @mica/sdk implementation and is published from no entry point. Publish ' +
        'the name on index.ts and addon.ts, route it through sdk/host/seam, or move the ' +
        'module to web/src/lib/phone if the SDK does not import it — see the block above.'
    ).toEqual([]);
  });

  it('the test-file exemption is exactly the list that declares it', () => {
    // The exemption is the one way this rule can go quiet, so it is asserted as an equality
    // rather than left as a filter. A new suite reaching into sdk/lib fails here until
    // somebody writes it down; one that stops reaching fails here too, so the list cannot
    // rot into a permission nobody needs any more.
    // This file is skipped over itself. The self-test above spells `@mica/sdk/lib/m3` as a
    // string literal so the detector can be driven with input the tree does not contain, and
    // `specifiers` cannot tell that from a real import — it reads quoted text, deliberately,
    // because a `vi.mock` path is a real edge. Without this the rule reports itself, which is
    // noise rather than a finding. Nothing else is exempted by shape.
    const tests = walk(SRC).filter((f) => f.endsWith('.test.ts') && f !== __filename);
    expect(tests.length, 'walked web/src and found no suites').toBeGreaterThan(20);

    expect([...new Set(sdkLibReaches(tests))]).toEqual(TEST_ONLY_REACHES);
  });
});
