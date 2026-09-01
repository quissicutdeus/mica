// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import fs from 'fs';
import path from 'path';

/**
 * Which apps are add-ons, read from manifest text (MICA-190).
 *
 * Text rather than an import, because both callers run before anything can evaluate a
 * TypeScript module: `vite.addon.config.ts` while Vite is still reading its own config, and
 * `build-addons.mjs` before it has spawned Vite at all.
 *
 * ## Why comments have to go first
 *
 * Both callers used to test `/core:\s*false/` against the raw file. A manifest's doc comment
 * is exactly where the word `core` gets discussed — `tools/addon-template`'s sample manifest
 * has a comment above `core: false` explaining what `core: true` would mean, and it failed to
 * build for that reason during MICA-175.
 *
 * In the template that failure was loud. **Here it points the other way and is silent.** The
 * question being asked is "does this manifest say `core: false`?", so a `core: true` app
 * whose comment happens to contain that string answers yes — and is then built as an add-on
 * bundle: compiled against `addon.ts`, wrapped by `bootAddOn`, and emitted as something the
 * Store can install and run in a sandboxed iframe. AGENTS.md §2.7 and §7 both rest on that
 * classification being right, because `core: true` is what gates `@gphone/sdk/core`, the raw
 * NUI transport. No manifest in the tree triggers it today, which is a fact about the current
 * comments rather than a property of the check.
 *
 * ## One module, not two copies
 *
 * `vite.addon.config.ts` carried this logic with a comment saying the dedupe had been tried
 * and abandoned — `tsc -p tsconfig.node.json` rejects importing a plain `.mjs` with no
 * declaration file — and that if the two ever drifted, the fix was "adding proper JS module
 * type support then, not hardcoding a list here". That is what the `.d.ts` beside this file
 * is. It lives under `web/` rather than the repo root because the demo image copies `web/`
 * and not `build/`, which is a different lesson from the same day.
 */

/**
 * Block comments and whole-line `//` comments removed.
 *
 * A `//` inside a string — a URL in a `description` — truncates its own line and no other,
 * and no property read this way lives on a line that could contain one.
 *
 * @param {string} source
 * @returns {string}
 */
export const withoutComments = (source) =>
  source.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/^\s*\/\/.*$/gm, '');

/**
 * `core: true` or `core: false` in *property position*, never a mention of one in prose.
 *
 * Anchored on what precedes it — start of line, `{`, or `,` — rather than requiring the whole
 * line, because a manifest may be written `defineApp({ id: 'notes', core: false })` on one
 * line as readily as across several. A line-anchored version passed against every manifest in
 * the tree and failed the moment a test wrote one inline, which is the sort of thing that
 * looks like coverage until the fixture changes.
 */
const CORE_DECLARATION = /(?:^|[{,])\s*core\s*:\s*(true|false)\b/m;

/**
 * What a manifest declares for `core`, or `null` if it declares neither.
 *
 * `null` rather than a default. "No `core: false` found" is not the same as "this is a core
 * app" — an omitted `core` is a manifest `defineApp` rejects outright, and a value the
 * discovery cannot read is one it must not classify by guessing.
 *
 * @param {string} source raw `manifest.ts` text
 * @returns {boolean | null}
 */
export function coreValueOf(source) {
  const found = CORE_DECLARATION.exec(withoutComments(source));
  return found ? found[1] === 'true' : null;
}

/**
 * Every app id under `appsDir` whose manifest declares `core: false`.
 *
 * @param {string} appsDir
 * @returns {string[]}
 */
export function addOnIds(appsDir) {
  return fs.readdirSync(appsDir).filter((id) => {
    const file = path.join(appsDir, id, 'manifest.ts');
    if (!fs.existsSync(file)) return false;
    return coreValueOf(fs.readFileSync(file, 'utf8')) === false;
  });
}
