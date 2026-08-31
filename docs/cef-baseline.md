# The Chromium 103 accommodations, and what to do when CEF moves

FiveM's release client renders NUI in CEF, and that CEF is **Chromium 103**. A
dev browser and Playwright are both current, so anything newer than 103 renders
perfectly everywhere a test can see and is broken in game. AGENTS.md §6 is the
rule that follows from this; this file is the inventory underneath it.

An upgrade (M140/M144) has been in progress upstream for some time and is not in
the release client. When it lands, every entry below stops being load-bearing on
its own schedule — and each one will by then look like ordinary code with no
reason attached. That is what this file is for, and the ticket that produced it:
MICA-67.

## How the baseline is known

Not from documentation. `web/src/shell/nuiGuard.ts` records a live verification
against **`Chrome/103.0.5060.141`**, made while debugging why real
`SendNUIMessage` events were being discarded. That user-agent string is the
firmest evidence in the repo that 103 is the real number rather than a
remembered one.

Nothing in the automated suite can confirm any of this. `pnpm test:e2e` drives a
modern Chromium; `sdk/cef.test.ts` and `lib/m3.test.ts` scan source text for
syntax, which is a proxy. Real verification is `nui_devTools` in the F8 console,
or `http://localhost:13172/` while the game runs, inspecting the **computed**
value rather than the declaration.

## The inventory

"Safe from" is the Chromium version at which the workaround stops being
necessary. Verified numbers come from `caniuse-lite@1.0.30001809` in this repo's
own lockfile; see [Which numbers were verified](#which-numbers-were-verified)
before trusting one.

### Version-gated: delete or revisit when the floor rises

| #   | Workaround                                                             | Where                                                                                                                            | Safe from                                                                               | Then what                                                                                                                  |
| --- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 1   | `oklab()`/`oklch()` lowered to an `rgb()` fallback, original preserved | `web/postcss.config.js` (`oklab-function`)                                                                                       | Chrome 111                                                                              | Delete the entry                                                                                                           |
| 2   | Space-separated `rgb(0 0 0 / 50%)` lowered to legacy comma form        | `web/postcss.config.js` (`color-functional-notation`)                                                                            | Chrome 65                                                                               | **Already redundant.** Delete independently of the upgrade — see below                                                     |
| 3   | Native CSS nesting flattened to plain selectors                        | `web/postcss.config.js` (`nesting-rules`)                                                                                        | Chrome 112 for the `&`-prefixed form this repo writes; **120** for bare-element nesting | Delete the entry — but read the nesting note below first                                                                   |
| 4   | `color-mix()` forbidden in authored CSS                                | AGENTS.md §6, `app.css`, `app-utilities.css`                                                                                     | Chrome 111                                                                              | Lift the ban; but read the `@supports` trap below                                                                          |
| 5   | M3 state layers composited numerically in JS instead of `color-mix()`  | `web/src/lib/sdk/m3.ts` (`composite`), consumed by `sdk/ui/NowPlayingCard.svelte`'s runtime cover tint (MICA-111) among others | Chrome 111                                                                              | Optional. Keeping it is defensible — one code path, no cascade recovery                                                    |
| 6   | Opacity modifier forbidden on a themed role token (`bg-surface/50`)    | `web/src/sdk/cef.test.ts`, `app.css`                                                                                             | Chrome 111                                                                              | Keep. The utility layer generates no such class, so lifting it is generation work, not a deletion                          |
| 7   | `:has()` banned outright                                               | `web/src/sdk/cef.test.ts` (`HAS_VARIANT`)                                                                                        | Chrome 105                                                                              | Delete the guard                                                                                                           |
| 8   | Container queries banned outright                                      | `web/src/sdk/cef.test.ts` (`CONTAINER_QUERY`)                                                                                    | Chrome 106 full (105 partial)                                                           | Delete the guard                                                                                                           |
| 9   | `dvh`/`svh` avoided; viewport measured in px and applied inline        | `shell/state/display.ts`, `shell/Shell.svelte` (the `<main>` inline `width`/`height`)                                            | Chrome 108                                                                              | **Keep, re-test only.** The measured value is also what the mobile-browser URL-bar case needs and what `fitScale` consumes |
| 10  | `linear()` easing avoided; `--ease-emphasized` is one cubic-bezier     | `web/src/app.css` (`--ease-emphasized`)                                                                                          | Chrome 113                                                                              | Optional: restore M3's true two-segment emphasized curve                                                                   |
| 11  | Relative colour syntax (`rgb(from …)`) rejected in inline styles       | `web/src/sdk/cef.test.ts` (`POST_103_COLOR`)                                                                                     | Chrome 131                                                                              | Keep well past M144                                                                                                        |
| 12  | Vite `build.target: 'chrome92'`                                        | `web/vite.config.ts`                                                                                                             | n/a — a deliberate floor                                                                | Raise deliberately. It also justifies dropping the `.woff` font fallback in `trimFonts`                                    |

### Not version-gated: do not delete these on an upgrade

These read like Chromium 103 accommodations and are not. Each survives the
upgrade unchanged, and the reason is written here so nobody removes one while
clearing out the list above.

| Workaround                                                        | Where                                                                                                                                                   | Why it stays                                                                                                                                            |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inline `style=` colours must be legacy `rgb()`/`rgba()`           | `lib/m3.ts` (`rgb`, `rgba`), `sdk/cef.test.ts`                                                                                                          | A markup attribute never passes through PostCSS, at any Chromium version. Permanent                                                                     |
| Every `var()` in an inline `style=` must resolve                  | `sdk/cef.test.ts`, `apps/bank/components/CreditCard.svelte` (the worked case)                                                                           | MICA-85. An unresolvable `var()` invalidates the whole declaration silently. Permanent                                                                |
| `bg-transparent` on the app wrapper                               | `shell/Shell.svelte`                                                                                                                                    | The game renders behind the overlay. A FiveM property                                                                                                   |
| No `window.location`, `window.open`, or anchor navigation         | AGENTS.md §6, `lib/markdown.ts`, `shell/MusicFrame.svelte` (`sandbox` withholds `allow-top-navigation`/`allow-popups` on the YouTube embed, MICA-111) | A redirect reloads the CEF instance and drops all state. A FiveM property                                                                               |
| No `a` in the DOMPurify allowlist                                 | `web/src/lib/sdk/markdown.ts`                                                                                                                           | Same, and a griefing vector (§7)                                                                                                                        |
| Resources served from `https://cfx-nui-<resource>/`               | —                                                                                                                                                       | A FiveM property                                                                                                                                        |
| Self-hosted `@fontsource/roboto`, not a Google Fonts `<link>`     | `web/src/app-reset.css`                                                                                                                                 | Needs a network request the client may not have. Not a version question                                                                                 |
| `execCommand` clipboard fallback                                  | `apps/settings/panes/About.svelte`                                                                                                                      | CEF can refuse the permission even in a secure context                                                                                                  |
| Eager `AudioContext` warm/unlock                                  | `shell/state/audio.ts`                                                                                                                                  | Autoplay policy, not a version gate                                                                                                                     |
| `-webkit-text-stroke` + `paint-order`                             | `app.css` (`.text-on-wallpaper`)                                                                                                                        | Chrome 79 — already below the floor. No action ever needed                                                                                              |
| WebP encoding, checked, falling back to JPEG                      | `web/src/lib/sdk/thumbnail.ts` (`encodeCanvas`)                                                                                                         | Chrome 32 — already safe. Moved out of `apps/camera/capture.ts`, which now only calls it — the gallery's own thumbnailing needed the same encoder       |
| `prefers-reduced-motion` read once, folded with a player override | `shell/state/motion.ts`                                                                                                                                 | Chrome 74 — already safe. What is not safe is assuming CEF forwards the host OS's setting at all; that is an embedding property no version bump answers |

### Re-test after the upgrade, version unknown

Three behaviours were tuned against CEF 103's renderer rather than against a
documented feature version. None has a "safe from" number, and each fails in a
way a test suite cannot see.

| Behaviour                                                                | Where                                             | Failure mode if it changes                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------ | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backgrounded in-process apps use `display:none`, not `visibility:hidden` | `shell/Shell.svelte` (the resident-app `{#each}`) | The outgoing app stayed partly on screen over the home screen: `backdrop-blur`/`transform`/`hover:scale` promote compositor layers that a hidden _ancestor_ did not reliably repaint                                                                                 |
| Backgrounded add-on iframes use `visibility:hidden`, not `display:none`  | `shell/Shell.svelte` (the add-on frame wrapper)   | The inverse. A `display:none` iframe collapsed to a 0x0 viewport and CEF 103 did not reliably lay it back out — the add-on came back blank, still running                                                                                                            |
| `SendNUIMessage` arrives with `event.source === window.top`              | `shell/nuiGuard.ts`                               | **The worst one.** This was verified live against 103.0.5060.141 after an earlier assumption (`source == null`) silently discarded every real NUI message and left the phone permanently blank. A CEF change here breaks the phone completely, with no console error |

## What `postcss.config.js` actually does

Verified empirically rather than read off the config, by running the repo's own
plugin list over a probe stylesheet (see
[Re-running the probe](#re-running-the-probe)). Input on the left, output in
game on the right:

| Written                             | Emitted                                                       |
| ----------------------------------- | ------------------------------------------------------------- |
| `oklch(0.7 0.1 200)`                | `rgb(64, 177, 183)` then the original, preserved              |
| `oklab(0.7 0.1 0.1)`                | `rgb(229, 127, 78)` then the original, preserved              |
| `rgb(0 0 0 / 50%)`                  | `rgba(0, 0, 0, 0.5)` then the original, preserved             |
| `.e { & .f { … } }`                 | `.e .f { … }` — flattened, original dropped                   |
| `color-mix(in srgb, red 50%, blue)` | `rgb(128, 0, 128)` — fully resolved, **no** `@supports` guard |
| `100dvh`, `:has()`, `@container`    | **passed through untouched**                                  |

Two things follow that the config file does not say.

**Entry 2 is already dead weight.** `color-functional-notation` exists to lower
space-separated `rgb()`, which Chromium has parsed since 65 — thirty-eight
versions below the floor. It can be deleted today. It is not why `lib/m3.ts`
writes legacy comma syntax: that code emits into an inline `style` attribute,
which never reaches PostCSS at all (see the permanent list above).

**Nesting is safe at 112 only because of how this repo writes it.** caniuse
records nesting as _partial_ from Chrome 112 and full from **120**; the gap is
bare-element nesting (`.a { h1 { … } }`), which needs the relaxed parsing that
landed in 120. All 35 nested blocks in `app-utilities.css` are `&`-prefixed, and
`app.css` and `app-reset.css` contain none — so 112 is the honest number _for
this codebase today_. Nothing enforces that convention. If the transform is
deleted at 112, a later bare-element nesting would break in game with no test
failing.

### The `@supports` trap behind the `color-mix()` ban

Worth spelling out, because the probe above makes `color-mix()` look safe: it
was fully resolved to `rgb(128, 0, 128)` with no fallback guard. That is true
only for **static operands**. Give it a `var()` and the output changes shape:

```css
/* written */
:root {
  --c: #ff0000;
}
.a {
  color: color-mix(in srgb, var(--c) 50%, blue);
}

/* emitted */
:root {
  --c: #ff0000;
}
.a {
  color: rgb(128, 0, 128);
}
@supports (color: color-mix(in lch, red, blue)) {
  .a {
    color: color-mix(in srgb, var(--c) 50%, blue);
  }
}
```

CEF 103 fails the `@supports` test, so it takes the flat fallback — and that
fallback was computed from `--c`'s _declared_ value at build time. Every role
token in this phone is written onto the screen element **at runtime** by
`PhoneFrame`, from the player's own seed. So the fallback is the default seed's
colour, applied to every player who changed their theme, silently and with no
error anywhere. This is exactly the failure AGENTS.md §6 and `app.css` describe
in prose; the mechanism is recorded here because the prose predates anyone
having actually run the transform.

The same shape applies to relative colour syntax (`oklch(from var(--c) …)`),
which is why `cef.test.ts` rejects it in inline styles too.

## Media playback: the ticket's premise needs correcting

MICA-67 frames video as a Chromium 103 limitation. Read from the code, it
mostly is not, and an upgrade will not on its own unblock it.

What is true today:

- There is **no `<video>` element anywhere** in `web/src`.
  `sdk/ui/MediaThumb.svelte` draws a video as its poster frame with a badge that
  is deliberately honest — "it says 'this is a video', not 'press to play'".
- There is **no `<audio>` element and no `decodeAudioData` either**. Every sound
  the phone makes is synthesized in `shell/state/audio.ts` from oscillators and
  a white-noise buffer. So the `audio` kind — voice notes — is equally
  unplayable, and renders a microphone placeholder from the same component. The
  ticket does not mention this.
- `gphone_media` already stores what playback would need: `url` (`varchar(512)`,
  server-written), `mime_type`, `thumbnail`, `duration_ms`.

Why the version is not the blocker: `<video>` with H.264 or WebM is a 2011-era
capability and Chromium 103 has it outright. `MediaThumb`'s own comment names
the real constraint — a clip "would have to arrive as base64 through the NUI
bridge", which is a transport and storage problem, not a codec one. Remote
`https:` images already render in game through the same `url` column and the
same `SAFE_SRC` predicate, which is direct evidence that the fetch path works.

So the action when M140 ships is **not** "video now works". It is:

1. Try a `<video src>` pointing at a remote `https:` URL, in game, today — this
   does not need the upgrade and may already work.
2. If it does, the poster-frame fallback becomes a graceful degrade for older
   clients rather than the only option, and `MediaThumb` is the one file that
   changes (its comment says so).
3. Voice-note playback is the same question with a smaller payload, and is what
   would make an `audio` kind more than a placeholder.

**A related but distinct question was answered separately.** MICA-111 built
music streaming as a sandboxed cross-origin YouTube iframe driven by
`postMessage` (`web/src/shell/MusicFrame.svelte`, `NearbyMusicFrame.svelte`) —
not a `<video>` element, and not `gphone_media`, so nothing above changes it.
Every capability that embed needs (`iframe sandbox`, Feature Policy, MSE, WebM,
Web Audio) checks out below the Chromium 103 floor against this same
`caniuse-lite` dataset, but whether CEF actually permits loading a third-party
document at all was — as of this writing — still an open, in-game question, not
one an upgrade would answer either. The verification procedure, its own
capability table, and why it does not double as proof that stored-media
`<video>` works are in
[`docs/testing-music-in-cef.md`](testing-music-in-cef.md), which depends on this
file rather than repeating it.

## Which numbers were verified

Verified against `caniuse-lite@1.0.30001809`, resolved from this repo's own
`node_modules`, reading first-full-support for Chrome:

| Feature                                    | First full Chrome      | At 103 |
| ------------------------------------------ | ---------------------- | ------ |
| CSS nesting                                | 120 (partial from 112) | no     |
| `color()` / `oklch()` / `oklab()`          | 111                    | no     |
| `:has()`                                   | 105                    | no     |
| Container queries                          | 106 (partial from 105) | no     |
| Container query units                      | 105                    | no     |
| Viewport unit variants (`dvh`/`svh`/`lvh`) | 108                    | no     |
| Relative colour syntax                     | 131                    | no     |
| `backdrop-filter`                          | 76                     | yes    |
| WebP                                       | 32                     | yes    |

**Not verified, inferred or taken from existing comments** — check before acting
on one:

- `color-mix()` at Chrome 111. caniuse-lite carries no discrete feature key for
  it in this version of the dataset. 111 is what AGENTS.md, `app.css` and
  `lib/m3.ts` all state, and it matches `color()`'s verified 111, but it was not
  independently confirmed here.
- `linear()` easing at Chrome 113 — taken from the `--ease-emphasized` comment
  in `app.css`.
- `paint-order` at Chrome 79 and `-webkit-text-stroke` — taken from the comment
  on `.text-on-wallpaper` in `app.css`. Both are far below the floor either way.
- Space-separated `rgb()` at Chrome 65 — well-established, but not confirmed
  from the local dataset.

Two numbers in AGENTS.md §6's gaps table differ from what the dataset says, and
both are the _partial_-support version rather than full: nesting (112, full 120)
and container queries (105, full 106). Neither is wrong for what the repo does
today; both are worth restating precisely when that table is next edited.

## Re-running the probe

Nothing here is a fixture, so it can be re-derived after any dependency bump.
From `web/`, with a scratch file:

```sh
node --input-type=module -e "
import postcss from 'postcss';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const cfg = (await import('./postcss.config.js')).default;
const plugins = Object.entries(cfg.plugins).map(([n, o]) => require(n)(o));
const r = await postcss(plugins).process('.a { color: oklch(0.7 0.1 200); }', { from: 'probe.css' });
console.log(r.css);
"
```

And for a support number, from the installed dataset rather than memory:

```sh
node -e "
const { feature } = require('caniuse-lite/dist/unpacker/feature');
const f = feature(require('caniuse-lite/data/features/css-nesting'));
console.log(f.stats.chrome['103'], f.stats.chrome['112'], f.stats.chrome['120']);
"
```

## The order to work in when the upgrade lands

1. Confirm the new baseline the same way it was confirmed before — read the real
   user-agent, do not trust the release notes. `nuiGuard.ts` is the precedent.
2. Re-verify the three renderer behaviours in the re-test table, `nuiGuard`
   first. A regression there blanks the phone and no suite will say so.
3. Drop the redundant `postcss.config.js` entries and update that file's comment
   to say which remain and why.
4. Delete the `cef.test.ts` guards the new floor makes vacuous, and the matching
   rows in AGENTS.md §6's gaps table. A stale ban shapes every CSS decision in
   the repo, so leaving one costs more than deleting it late.
5. Raise `build.target` in `web/vite.config.ts` deliberately, as its own change.
6. Re-test media playback per the section above — starting with a remote URL,
   which may not need the upgrade at all.
