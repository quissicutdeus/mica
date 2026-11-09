<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

# The frozen add-on

`frozenprobe.js` stands in for an add-on that somebody outside this repo built
and published long ago (MICA-462). It is **never rebuilt** to make a suite pass.
`web/e2e/frozen-addon.spec.ts` boots it on every run, and
`web/src/lib/frozenAddon.test.ts` pins its hash.

|                  |                                                                    |
| ---------------- | ------------------------------------------------------------------ |
| Contract version | `1` (`sdkContract` in `entry.json`; `sdk/version.ts`)              |
| Built from       | `5e384216af9581795db0f4fca80935dcc28597bf` on `dev`                |
| sha256           | `cd1f4a28d2332c4cc2700cb4cd8db133e35d2b15b57d268d84082b3c62b5113e` |
| Built with       | `tools/addon-template/vite.config.ts`, production mode             |

The sha is the checkout the SDK was read from: the bundle contains `sdk/` as it
was there, which is the point.

## Files

- `src/` is the add-on's source: a manifest, an icon and one component.
  `.svelte.src` because ESLint types every `.svelte` file through a tsconfig
  that includes nothing under `e2e/`.
- `frozenprobe.js` is the bundle, as built.
- `entry.json` is the catalog entry an author would publish with it. It grants
  `notifications` and not `contacts`, though the manifest in `src/` declares
  both: the gap is the undeclared call the spec watches the shell refuse.
- `build.mjs` is the recipe as a script.

## Rebuilding it

Only on the owner's explicit word, like the contract version. Check out the sha
above, then, from the repo root:

```sh
node web/e2e/fixtures/frozen-addon/build.mjs <an empty scratch directory>
```

The build is deterministic: the same checkout gives the same bytes. Copy
`<scratch>/dist/frozenprobe.js` and `<scratch>/entry.json` over the committed
pair, and set the new hash in `web/src/lib/frozenAddon.test.ts`. Do the build in
a scratch directory, never in `web/public/addons/`.

A refresh from a later sha is a different fixture: it no longer says what an
add-on built against the old wire does. Replace it only when the contract
version moves, and say in the commit which sha it now comes from.
