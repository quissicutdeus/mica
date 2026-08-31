/**
 * Centralized gPhone Versioning & Smart Build Information
 *
 * Two numbers live here and they answer different questions. `SDK_CONTRACT_VERSION` is
 * *what an add-on compiled against*; `MICA_VERSION` is *which build of the phone is
 * running it*. Only the first is stable enough to branch on, and only the first is
 * knowable from inside an add-on's own bundle — see each one below.
 */

/**
 * The version of the **contract** `@gphone/sdk` publishes: the exported names of each entry
 * point, the props of every exported component, and the members of every exported string
 * vocabulary. It moves when that surface moves and at no other time, which is the whole
 * reason it is worth reading.
 *
 * `publicSurface.test.ts` pins its frozen baselines to this value and imports it from here
 * rather than declaring a copy — landing a break means bumping this *and* re-freezing those
 * baselines in the same commit, so the break is a reviewable line in a diff. It lived as a
 * `const` inside that test file until MICA-173, where nobody outside this repo could
 * import it; the file said as much itself.
 *
 * **Not** `MICA_VERSION` below, which is a CalVer build stamp computed from `git log` and
 * moves on every push to `main` (eleven tags on 2026-08-27 alone) — an add-on branching on
 * it is branching on noise. **Not** `package.json`'s `1.0.0` either, which is a placeholder
 * read by no code and would advertise a published npm package that does not exist.
 *
 * Typed `string` rather than the literal `'1'` on purpose: the one call site this export
 * exists for is an add-on comparing it against the version it was written against, and a
 * literal type makes `SDK_CONTRACT_VERSION === '2'` a "this comparison appears
 * unintentional" error rather than a check.
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
 * `__MICA_VERSION__` is substituted by `define` at build time. The shell's
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
 * So: `if (MICA_VERSION)` before using it, and read `SDK_CONTRACT_VERSION` above for the
 * question "what can I call?" — which is the one an add-on actually has.
 */
export const MICA_VERSION: string =
  typeof __MICA_VERSION__ !== 'undefined' ? __MICA_VERSION__ : '';

/**
 * The human-readable build line — `v2026.08.30.47 (branch@sha)` — shown in Settings >
 * About, or the empty string on the same terms as `MICA_VERSION` above.
 *
 * The old `` `v${MICA_VERSION}-dev` `` fallback would now render as the meaningless
 * `v-dev`; with nothing to describe, it says nothing.
 */
export const MICA_BUILD_INFO: string =
  typeof __MICA_BUILD_INFO__ !== 'undefined'
    ? __MICA_BUILD_INFO__
    : MICA_VERSION
      ? `v${MICA_VERSION}-dev`
      : '';
