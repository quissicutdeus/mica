// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Centralized gOS Versioning & Smart Build Information
 *
 * Two numbers live here and they answer different questions. `SDK_CONTRACT_VERSION` is
 * *what an add-on compiled against*; `GOS_VERSION` is *which build of the phone is
 * running it*. Only the first is stable enough to branch on, and only the first is
 * knowable from inside an add-on's own bundle — see each one below.
 */

/**
 * The version of the **contract** `@gos/sdk` publishes: the exported names of each entry
 * point — **the values an add-on can call and the types it can name, equally** — the props
 * of every exported component, and the members of every exported string vocabulary. It
 * moves when that surface moves and at no other time, which is the whole reason it is worth
 * reading.
 *
 * That "and the types" is spelled out because the sentence used to say "the exported names"
 * and leave it open, and the check behind it read the surface with a runtime `import *`,
 * which cannot see a type at all. Sixty-three published names on `index.ts` and sixty-two on
 * `addon.ts` were outside the gate in both directions until MICA-182 closed it. An add-on
 * that writes `import type { Note } from '@gos/sdk'` is broken by that name disappearing
 * in exactly the way one calling a deleted hook is, so this number moves for both.
 *
 * `publicSurface.test.ts` pins its frozen baselines to this value and imports it from here
 * rather than declaring a copy — landing a break means bumping this *and* re-freezing those
 * baselines in the same commit, so the break is a reviewable line in a diff. It lived as a
 * `const` inside that test file until MICA-173, where nobody outside this repo could
 * import it; the file said as much itself.
 *
 * **Not** `GOS_VERSION` below, which is a CalVer build stamp computed from `git log` and
 * moves on every push to `main` (eleven tags on 2026-08-27 alone) — an add-on branching on
 * it is branching on noise. **Not** `package.json`'s `1.0.0` either, which is a placeholder
 * read by no code and would advertise a published npm package that does not exist.
 *
 * Typed `string` rather than the literal `'1'` on purpose: the one call site this export
 * exists for is an add-on comparing it against the version it was written against, and a
 * literal type makes `SDK_CONTRACT_VERSION === '2'` a "this comparison appears
 * unintentional" error rather than a check.
 *
 * **The design system is out of contract.** `app.css`, `app-utilities.css` and
 * `app-reset.css` moved into the package on MICA-172, and this number does not move when
 * they change. That is not an oversight: an add-on reads this to decide what it may *call*,
 * and there is no equivalent question for a utility class. Nor is there a mechanism to ask
 * one — an add-on's CSS is inlined from whatever `vite.addon.config.ts` injected at *its*
 * build, so no add-on can have compiled against one stylesheet and been handed another. A
 * number that moved for every colour tweak would stop meaning anything for the case it
 * exists to serve, which is the one thing it must not do.
 *
 * Note what it does *not* do: nothing consults it at install or boot time. There is no
 * runtime compatibility gate anywhere in the phone (MICA-173), and adding one is new
 * manifest surface that needs deciding on its own. This is a number an add-on author can
 * read and act on; it is not a number the shell enforces.
 */
export const SDK_CONTRACT_VERSION: string = '1';

/**
 * The running phone's CalVer build stamp — `YYYY.MM.DD.N` — or the empty string when the
 * bundle asking has no way to know it.
 *
 * `__GOS_VERSION__` is substituted by `define` at build time. The shell's
 * `vite.config.ts` supplies the real stamp. A `core: false` add-on's bundle
 * (`vite.addon.config.ts`) deliberately supplies `''` instead, and so does any third-party
 * bundler that has never heard of the identifier and leaves the fallback here to fire.
 *
 * Why empty rather than a number: an add-on bundle is compiled once and then loaded by
 * whatever phone happens to install it, so the host's build version is genuinely not
 * knowable when the bundle is written. Until MICA-170 the fallback was `'1.0.0'`, which
 * meant every published add-on read a plausible, confidently wrong version forever — worse
 * than an absent one, because nothing about it looks like an error. `''` is the encoding
 * this tree already gives to "not a version": `lib/semver.ts` returns `null` (*not
 * orderable*) for it rather than folding it into "up to date", and the Store's own
 * `{app.version || '1.0.0'}` and `{#if app.version}` call sites already treat a falsy
 * version as its own case.
 *
 * So: `if (GOS_VERSION)` before using it, and read `SDK_CONTRACT_VERSION` above for the
 * question "what can I call?" — which is the one an add-on actually has.
 */
export const GOS_VERSION: string = typeof __GOS_VERSION__ !== 'undefined' ? __GOS_VERSION__ : '';

/**
 * The human-readable build line — `v2026.08.30.47 (branch@sha)` — shown in Settings >
 * About, or the empty string on the same terms as `GOS_VERSION` above.
 *
 * The old `` `v${GOS_VERSION}-dev` `` fallback would now render as the meaningless
 * `v-dev`; with nothing to describe, it says nothing.
 */
export const GOS_BUILD_INFO: string =
  typeof __GOS_BUILD_INFO__ !== 'undefined'
    ? __GOS_BUILD_INFO__
    : GOS_VERSION
      ? `v${GOS_VERSION}-dev`
      : '';

/**
 * The branch this build came from, on its own rather than embedded in the line above.
 *
 * `GOS_BUILD_INFO` has carried the branch since it existed, welded into
 * `v<calver> (<branch>@<sha>)` for a human to read. MICA-192 needs it as a value —
 * `licenseNotice.ts` builds the §13 source address out of it — and picking it back out of
 * the display string with a regex would mean re-deriving something `vite.config.ts` already
 * had and threw away.
 *
 * Empty on the same terms as `GOS_VERSION`: an add-on bundle is compiled once and run by
 * whatever phone installs it, so the host's branch is not knowable when the bundle is
 * written. `sourceUrlForBuild` degrades to the repository root rather than inventing a
 * `/tree/` path for a branch it cannot name.
 */
export const GOS_BRANCH: string = typeof __GOS_BRANCH__ !== 'undefined' ? __GOS_BRANCH__ : '';
