// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The out-of-tree add-on template must keep saying what this repo's add-on build says.
 *
 * MICA-175. `tools/addon-template/` is a standalone project an author fetches with
 * `degit` and builds with no clone of this repo. Its `vite.config.ts` is a **copy** of
 * `web/vite.addon.config.ts`'s decisions, and it has to be a copy rather than an import:
 * the phone's config lives in the `web` workspace, which the author does not have, and the
 * only two packages they do have (`@gphone/sdk`, `@gphone/shared`) deliberately publish no
 * build tooling.
 *
 * A copy drifts. The failure mode is specific and bad: an add-on built out of tree that
 * *works* — installs, boots, renders in a browser — and differs from an in-tree bundle in
 * one of the handful of ways that only show up in FiveM's CEF or under the Store's loader.
 * Raise `build.target` past `chrome92` and the bundle throws in game. Lose
 * `codeSplitting: false` and it emits a shared chunk the `data:`-URL loader can never
 * fetch. Lose `inlineCss` and the stylesheet is an asset nothing loads. Lose the `define`
 * block and every published add-on reads a confidently wrong `MICA_VERSION`, which is
 * MICA-170 happening a second time to somebody who cannot see this repo. None of those
 * fails a build, and no suite an author can run would notice.
 *
 * ## What this reads, and what it cannot
 *
 * It compares **source text**, not behaviour. Both files are read from disk and each knob
 * below is required to appear in each — so a value changed on one side and not the other
 * fails here, which is the drift this exists for.
 *
 * It cannot see: a plugin whose body has changed while its name and options stayed put; a
 * knob added to one config that neither side's list here mentions; or anything about
 * whether the emitted bundles actually match, which needs an out-of-tree build and is not
 * something a unit test can run. Those are review questions. This is the cheap gate that
 * catches the common one — somebody editing `vite.addon.config.ts` and not knowing the
 * template exists — and its whole value is that it names the file to go and edit.
 *
 * Importing the two configs and diffing the resolved objects would be stronger and was
 * tried. It does not work: the template's config resolves `@gphone/sdk` and
 * `@sveltejs/vite-plugin-svelte` from `tools/addon-template/node_modules`, which exists
 * only after an author installs, and is not present in this repo's tree at all.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PHONE_CONFIG = path.join(ROOT, 'web/vite.addon.config.ts');
const TEMPLATE_DIR = path.join(ROOT, 'tools/addon-template');
const TEMPLATE_CONFIG = path.join(TEMPLATE_DIR, 'vite.config.ts');

const read = (file: string): string => fs.readFileSync(file, 'utf8');

/**
 * Every decision that changes what a bundle *is* rather than how it was produced.
 *
 * A pattern, not a literal string, so incidental formatting differences between the two
 * files do not fail this — the two configs are written for different readers and are not
 * expected to be character-identical anywhere except in what they decide.
 */
const SHARED_DECISIONS: [name: string, pattern: RegExp][] = [
  // Chromium 103 is FiveM's release CEF; `chrome92` is the floor this repo builds to,
  // deliberately below it. Raising it is the single most dangerous silent divergence here.
  ['build.target is chrome92', /target:\s*'chrome92'/],
  // One chunk per entry. The add-on iframe loads a `data:` module URL and has no way to
  // fetch a sibling.
  ['output.codeSplitting is false', /codeSplitting:\s*false/],
  ['output.preserveModules is false', /preserveModules:\s*false/],
  // The stylesheet has to end up inside the chunk; there is no document to `<link>` from.
  ['build.cssCodeSplit is false', /cssCodeSplit:\s*false/],
  ['the CSS is inlined into the entry chunk', /document\.createElement\('style'\)/],
  // Always, `--watch` included: the bundle text is what gets `encodeURIComponent`d.
  ['build.minify is true', /minify:\s*true/],
  ['the output is a single ES lib entry', /formats:\s*\['es'\]/],
  // MICA-170. Both identifiers substituted, both with the empty string, on both sides.
  [
    '__MICA_VERSION__ is defined as the empty string',
    /__MICA_VERSION__:\s*JSON\.stringify\(''\)/
  ],
  [
    '__MICA_BUILD_INFO__ is defined as the empty string',
    /__MICA_BUILD_INFO__:\s*JSON\.stringify\(''\)/
  ],
  ['no `__MICA_*__` identifier may survive into the output', /__MICA_\[A-Za-z0-9_\]\*__/],
  // Neither package declares `sideEffects: false`, so without this every add-on ships a
  // Markdown parser and a sanitiser whether or not it renders Markdown.
  ['marked and dompurify are treeshaken as side-effect-free', /marked\|dompurify/],
  ['resolution prefers the browser condition', /conditions:\s*\['browser'\]/],
  // AGENTS.md §2.7. The one divergence that would be a privilege-escalation route rather
  // than a rendering bug.
  ['@gphone/sdk/core is refused', /@gphone\\\/sdk\\\/core\(\\\/\.\*\)\?\$/]
];

describe('the out-of-tree add-on template', () => {
  it('is on disk, with the files an author is told they will get', () => {
    // Non-vacuity: every assertion below reads one of these, so a missing template would
    // otherwise make this whole file pass by comparing nothing.
    for (const file of [
      'README.md',
      'package.json',
      'pnpm-workspace.yaml',
      'postcss.config.js',
      'svelte.config.js',
      'tsconfig.json',
      'vite.config.ts',
      'src/manifest.ts',
      'src/index.svelte',
      'src/Icon.svelte'
    ]) {
      expect(fs.existsSync(path.join(TEMPLATE_DIR, file)), `${file} is missing`).toBe(true);
    }
  });

  it('decides the same things about a bundle that web/vite.addon.config.ts does', () => {
    const phone = read(PHONE_CONFIG);
    const template = read(TEMPLATE_CONFIG);
    expect(phone.length).toBeGreaterThan(1000);
    expect(template.length).toBeGreaterThan(1000);

    const missing = SHARED_DECISIONS.flatMap(([name, pattern]) => [
      ...(pattern.test(phone) ? [] : [`web/vite.addon.config.ts no longer says: ${name}`]),
      ...(pattern.test(template)
        ? []
        : [`tools/addon-template/vite.config.ts no longer says: ${name}`])
    ]);

    expect(
      missing,
      "the phone's add-on build and the out-of-tree template have diverged. An add-on " +
        'built from the template is installed and run by this phone, so a decision that ' +
        'holds in one and not the other produces a bundle that builds, boots, and is wrong ' +
        "in a way only FiveM's CEF or the Store loader sees. Change both, or — if the " +
        'divergence is deliberate — take the entry out of SHARED_DECISIONS with the reason.'
    ).toEqual([]);
  });

  it('lowers CSS to the Chromium 103 baseline, as the phone does', () => {
    /**
     * `web/postcss.config.js` sits at the root Vite discovers from, so the phone's add-on
     * build inherits it without naming it. Out of tree there is nothing to inherit from,
     * and the consequence is not cosmetic: `sdk/app-utilities.css` nests, native nesting is
     * Chromium 112, and the SDK stylesheet is inlined into every add-on bundle. A template
     * without this file produces an add-on that renders correctly everywhere an author can
     * look and drops thirty-odd rule blocks in game.
     */
    const phone = read(path.join(ROOT, 'web/postcss.config.js'));
    const template = read(path.join(TEMPLATE_DIR, 'postcss.config.js'));
    for (const feature of ['nesting-rules', 'oklab-function', 'color-functional-notation']) {
      expect(phone, `web/postcss.config.js dropped ${feature}`).toContain(feature);
      expect(
        template,
        `tools/addon-template/postcss.config.js dropped ${feature} — an add-on built from ` +
          'the template would ship CSS the game cannot parse'
      ).toContain(feature);
    }
  });

  it('names one git ref for both unpublished packages', () => {
    /**
     * `@gphone/sdk` and `@gphone/shared` are separate packages that share a wire
     * vocabulary, and the SDK re-exports from `shared`. Installing them from two different
     * commits typechecks in the easy cases and is wrong in the interesting ones, so the
     * dependency, the second dependency and the `overrides` entry that redirects the SDK's
     * own `workspace:*` all have to name the same ref. Three places, edited by hand, is
     * exactly the shape that drifts.
     */
    const pkg = JSON.parse(read(path.join(TEMPLATE_DIR, 'package.json'))) as {
      dependencies: Record<string, string>;
    };
    const workspace = read(path.join(TEMPLATE_DIR, 'pnpm-workspace.yaml'));

    const refOf = (spec: string): string | undefined =>
      /^github:quissicutdeus\/gPhone#([^&]+)&path:\/(sdk|shared)$/.exec(spec)?.[1];

    const sdkRef = refOf(pkg.dependencies['@gphone/sdk'] ?? '');
    const sharedRef = refOf(pkg.dependencies['@gphone/shared'] ?? '');
    const overrideSpec = /'@gphone\/shared':\s*'([^']+)'/.exec(workspace)?.[1] ?? '';
    const overrideRef = refOf(overrideSpec);

    expect(sdkRef, '@gphone/sdk is not a github:…#<ref>&path:/sdk specifier').toBeDefined();
    expect([sharedRef, overrideRef]).toEqual([sdkRef, sdkRef]);

    /**
     * Not a formality either: `blockExoticSubdeps` defaults to true in pnpm 11 and refuses
     * a git dependency reached through an override, and pnpm 11 ignores a `pnpm` field in
     * `package.json` outright — so both settings have to be in this file or `pnpm install`
     * fails on a fresh checkout of the author's project, talking about a workspace that is
     * not theirs.
     */
    expect(workspace).toContain('blockExoticSubdeps: false');
    expect(pkg).not.toHaveProperty('pnpm');
  });
});
