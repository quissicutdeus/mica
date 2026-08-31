import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * `web/src/lib/` has two owners, and this is the seam between them. MICA-171.
 *
 * Before this split, `lib/` was one flat directory of "helpers", and the SDK's *public*
 * exports were implemented in it — `isBrowser`, `filterByQuery`, the formatters,
 * `renderMarkdown`, `useScrollDetect` and the thumbnail set are all re-exported by
 * `sdk/utils.ts`, `fade`/`fly` by `sdk/index.ts`, `placeholderImage` by both barrels. Seven
 * UI primitives under `sdk/ui/` reached into `lib/` directly as well. So the implementation
 * of `@gphone/sdk` sat outside `sdk/`, and MICA-172 (moving the SDK to a root-level
 * workspace package) could not start until that was untangled.
 *
 * The split is by **owner**, not by subject matter:
 *
 * - `lib/sdk/` — owned by `@gphone/sdk`. Reachable from the published contract, directly or
 *   transitively. It travels with the SDK on MICA-172, so it must stay bundle-safe: no
 *   phone state, no shell, no I/O (AGENTS.md §8).
 * - `lib/phone/` — owned by the shell. Nothing in `web/src/sdk/` may reach it. It stays in
 *   `web/` when the SDK leaves.
 *
 * `lib/phone/` may import `lib/sdk/` (`debug.ts` uses `isBrowser`). The reverse is the
 * violation, and rule 3 below is what makes it one.
 *
 * A note on reading relative paths in here, because the two `sdk` directories are one
 * segment apart: from inside `lib/phone/` or `lib/sdk/`, `'../sdk/x'` is the *lib* half and
 * `'../../sdk/x'` is the real `web/src/sdk/`. Both resolve, and getting it wrong is a
 * compile error rather than a silent bug, but they do not mean the same thing.
 *
 * ## The triage, module by module
 *
 * "The SDK imports it today" was the starting point, not the answer — the alternative
 * verdict for anything the SDK reaches is *remove the SDK's use of it*, and that was
 * considered for each. Nothing in the SDK-reached set turned out to be phone-only.
 *
 * **`lib/sdk/` — public surface.** `isBrowser`, `filterByQuery`, `formatters`, `markdown`,
 * `useScrollDetect`, `thumbnail` (re-exported by `sdk/utils.ts`), `motion` (`fade`/`fly`,
 * `sdk/index.ts` + `sdk/addon.ts`), `placeholderImage` (both barrels), `m3` (the `M3Tokens`
 * type, both barrels). An add-on resolves these names, so their implementation is SDK-owned
 * by definition.
 *
 * **`lib/sdk/` — SDK-internal, not public.** `dominantColor`, `musicErrors`,
 * `musicBroadcast`, `seed`. None is exported from `sdk/index.ts`, `sdk/addon.ts` or
 * `sdk/core.ts`; each is a dependency of something that is. They are SDK-owned because the
 * SDK cannot be moved without them, not because an add-on can name them.
 *
 * `errors` (`messageOf`) and `focusTrap` were in this second group when MICA-171 wrote it
 * and are now in the first: MICA-172 exports both from `sdk/utils.ts`, on the owner's
 * call, because an add-on writing its own modal had no focus trap and an add-on catching a
 * rejected `useService` call had no safe way to read the message. The split itself did not
 * move — both were already SDK-owned, which is why promoting them was a one-line barrel
 * change rather than a migration. That is the split doing its job.
 *
 * `musicBroadcast` and `seed` were the two the ticket flagged, and both are
 * SDK-owned for the same structural reason: the iframe facet twins
 * (`sdk/host/iframe/facets/music.ts`, `.../theme.ts`) may import nothing from `shell/`, so
 * the constants and the seed sanitizer were pulled out of `shell/state/` and `m3.ts`
 * precisely so an add-on's bundle could carry them. Removing the SDK's use of either would
 * mean putting a shell import back into an iframe twin, which is the thing `seam.test.ts`
 * exists to forbid.
 *
 * **`m3.ts` is SDK-owned**, confirmed rather than assumed: it is already reached from
 * `sdk/index.ts`, `sdk/addon.ts`, `sdk/ui/NowPlayingCard.svelte`, both theme facets and
 * `sdk/cef.test.ts`, and a decision on MICA-172 puts the design system on the SDK side.
 * `app.css` / `app-utilities.css` are **not** moved here — that is MICA-172's to do.
 *
 * **`lib/phone/`.** `pointerDrag`, `sheetDrag`, `longPressDrag`, `dragRatio`, `dragScroll`
 * are the shell's gesture plumbing and have no importer in `sdk/`. `debug` is the browser
 * dev harness's event emulator. `semver` answers one question for the Store's update row.
 * `appVisibility` is the launcher/dock/drawer visibility rule. None is reachable from the
 * published contract.
 *
 * ## What this file does not cover
 *
 * `boundary.test.ts` still forbids an app importing `lib/` at all, either half.
 * `seam.test.ts` still walks transitively out of the kit and iframe entries and would
 * catch a `lib/sdk/` module that started reaching the shell from further away than rule 5
 * looks. This file is the ownership question only.
 */

const LIB = __dirname;
const SRC = join(LIB, '..');
const SDK = join(SRC, 'sdk');

const SDK_OWNED = join(LIB, 'sdk');
const PHONE_OWNED = join(LIB, 'phone');

const walk = (path: string): string[] => {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path).flatMap((entry) => walk(join(path, entry)));
};

const isSource = (file: string) => /\.(ts|svelte)$/.test(file) && !file.endsWith('.test.ts');

/**
 * Any quoted specifier, wherever it appears — `import`/`export ... from`, a dynamic
 * `import()`, and a `vi.mock()` path, which is a real edge (`NowPlayingCard.test.ts` mocks
 * `lib/sdk/dominantColor` that way) and is invisible to an `import`-anchored pattern.
 * Matching the quoted form rather than the bare text is what keeps a prose mention of
 * `lib/phone/semver.ts` in a doc comment from failing a rule.
 */
const specifiers = (file: string): string[] =>
  [...readFileSync(file, 'utf8').matchAll(/['"]([^'"\n]*\/[^'"\n]*)['"]/g)].map((m) => m[1]);

describe('lib/ is split by owner', () => {
  /**
   * Totality. A new helper dropped at `lib/` root belongs to nobody, and "nobody" resolves
   * in practice to "whoever imports it first" — which is how the SDK ended up implemented
   * outside itself in the first place. A third subdirectory is the same problem wearing a
   * name, so the check is an equality rather than a "not at root".
   */
  it('every source module lives in exactly one of lib/sdk or lib/phone', () => {
    const strays = readdirSync(LIB)
      .filter((entry) => !statSync(join(LIB, entry)).isDirectory())
      .filter(isSource);

    const dirs = readdirSync(LIB).filter((entry) => statSync(join(LIB, entry)).isDirectory());

    expect(strays, 'put it in lib/sdk (the SDK can reach it) or lib/phone (it cannot)').toEqual([]);
    expect(dirs.sort(), 'lib/ has exactly two owners; a third directory owns nothing').toEqual([
      'phone',
      'sdk'
    ]);
  });

  it('finds modules on both sides to check', () => {
    // Every rule below is a "no offenders" assertion, and each would pass vacuously if its
    // walk turned up nothing.
    expect(walk(SDK_OWNED).filter(isSource).length).toBeGreaterThan(10);
    expect(walk(PHONE_OWNED).filter(isSource).length).toBeGreaterThan(5);
  });

  /**
   * The direction of the seam. `lib/phone/` may depend on `lib/sdk/`; the reverse would put
   * shell-owned code inside the package MICA-172 moves out, which is the failure this
   * whole split exists to make impossible.
   */
  it('no lib/sdk module imports lib/phone', () => {
    const offenders = walk(SDK_OWNED)
      .flatMap((file) =>
        specifiers(file)
          .filter((s) => /(^|\/)phone\//.test(s) && s.startsWith('.'))
          .map((s) => `${relative(SRC, file)}  ->  ${s}`)
      )
      .sort();

    expect(
      offenders,
      'lib/sdk travels with @gphone/sdk — a phone-owned helper cannot come with it'
    ).toEqual([]);
  });

  /**
   * The rule the ticket asks for by name: a phone-only module gaining an SDK importer fails
   * the build rather than being caught at review. Test files under `sdk/` are checked too —
   * an SDK suite reaching for `lib/phone` is the same misfiling, one commit earlier.
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
      'move the module to lib/sdk if the SDK genuinely owns it — otherwise drop the import'
    ).toEqual([]);
  });

  /**
   * `lib/sdk/` has to stay bundle-safe, which is the operative half of "SDK-owned": an
   * add-on's bundle has no `shell/`, `services/` or `nui/` at the other end of an import,
   * and MICA-172 moves this directory somewhere none of those three resolve from at all.
   *
   * One exemption, and it is a real leak rather than a category: `lib/sdk/formatters.ts`
   * imports `is24Hour` from `shell/state/time` for `formatTime`'s default. The add-on build
   * redirects that specifier to `sdk/host/iframe/shims/time.ts` before rollup resolves it
   * (`vite.addon.config.ts`'s `shellTimeShim`), and `seam.test.ts` exempts the same
   * specifier from the same walk for the same reason. **It is a build-time patch over a
   * source-level dependency, and MICA-172 has to resolve it properly** — a package that
   * is no longer inside `web/src/` cannot spell `../../shell/state/time` at all. Kept as a
   * one-entry allowlist rather than a directory exception so a second one has to be argued
   * for in a diff.
   */
  const ALLOWED_SHELL_EDGES = [/(^|\/)shell\/state\/time$/];

  it('no lib/sdk module reaches the shell, outside the one documented edge', () => {
    const offenders = walk(SDK_OWNED)
      .filter(isSource)
      .flatMap((file) =>
        specifiers(file)
          .filter((s) => s.startsWith('.') && /(^|\/)(shell|services|nui|apps)\//.test(s))
          .filter((s) => !ALLOWED_SHELL_EDGES.some((allowed) => allowed.test(s)))
          .map((s) => `${relative(SRC, file)}  ->  ${s}`)
      )
      .sort();

    expect(
      offenders,
      'lib/sdk is bundled into add-ons and leaves web/ on MICA-172 — ask through a host hook instead'
    ).toEqual([]);
  });
});
