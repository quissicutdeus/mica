// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// @ts-expect-error -- a plain .js build script with no types; this suite is not typechecked.
import { renderAppIcons } from '../../scripts/lib/app-icons.js';

/**
 * The catalog's icons, which nothing else can prove.
 *
 * `generate-catalog.js` used to emit no `icon` at all, on the reasoning that a component
 * cannot become JSON. Everything downstream was already right — `installVerified` copies
 * `entry.icon` onto the manifest and `AppIcon` renders `<img src={icon}>` for a string — so
 * a catalog install simply got `null` and the Store drew a coloured tile with no glyph, and
 * the home screen kept it after install. It passed every suite: the shell's own tests
 * fixture catalog entries with `icon: null`, which is the broken shape asserted as correct.
 *
 * So this stands one level up, over the thing that produces the value rather than the thing
 * that consumes it. It renders the real add-on icons — no built `dist/` needed, which is
 * why the pipeline lives in `scripts/lib/app-icons.js` rather than inside the generator.
 */

const root = resolve(__dirname, '../..');
const appsDir = join(root, 'web/src/apps');

/** The same rule `generate-catalog.js` picks add-ons by: a manifest declaring `core: false`. */
const addOnIds = (): string[] =>
  readdirSync(appsDir).filter((id) => {
    const manifest = join(appsDir, id, 'manifest.ts');
    if (!existsSync(manifest)) return false;
    const source = readFileSync(manifest, 'utf8')
      .replaceAll(/\/\*[\s\S]*?\*\//g, '')
      .replaceAll(/^\s*\/\/.*$/gm, '');
    return /^\s*core:\s*false\s*,?\s*$/m.test(source);
  });

const decode = (dataUri: string): string =>
  decodeURIComponent(dataUri.slice('data:image/svg+xml,'.length));

describe('a catalog entry carries a rendered icon', () => {
  const ids = addOnIds();

  it('finds the add-ons to render', () => {
    expect(ids.length).toBeGreaterThan(0);
  });

  it('renders every add-on icon to a standalone SVG data URI', async () => {
    const icons = await renderAppIcons({
      root,
      appsDir,
      apps: ids.map((id) => ({ id, fg: undefined }))
    });

    expect(icons).toHaveLength(ids.length);
    for (const [i, icon] of icons.entries()) {
      expect(icon, ids[i]).toMatch(/^data:image\/svg\+xml,/);
      const svg = decode(icon);
      expect(svg, ids[i]).toMatch(/^<svg\b/);
      expect(svg, ids[i]).toMatch(/<\/svg>$/);
      // Required in a data: URI, optional in HTML — without it the icon renders in the dev
      // browser and is blank as an <img> everywhere else.
      expect(svg, ids[i]).toContain('xmlns="http://www.w3.org/2000/svg"');
      // An <img> is a document boundary: nothing inside it can inherit the tile's colour.
      expect(svg, ids[i]).not.toContain('currentColor');
    }
  }, 30_000);

  /**
   * The two halves of the tile, since `fg` is the whole reason the colour is resolved at
   * build time rather than left to CSS. A dark tile states none and takes white; a light one
   * states a class, and the value comes out of `sdk/app-utilities.css` rather than a second
   * copy of it here.
   */
  it('bakes the tile foreground into the glyph', async () => {
    const [dark, light] = await renderAppIcons({
      root,
      appsDir,
      apps: [
        { id: 'blabber', fg: undefined },
        { id: 'blabber', fg: 'text-gray-900' }
      ]
    });

    expect(decode(dark)).toContain('#ffffff');
    expect(decode(light)).toContain('#111827');
    expect(decode(light)).not.toContain('#ffffff');
  }, 30_000);

  it('refuses a foreground class the stylesheet does not define', async () => {
    await expect(
      renderAppIcons({
        root,
        appsDir,
        apps: [{ id: 'blabber', fg: 'text-not-a-real-class' }]
      })
    ).rejects.toThrow(/sdk\/app-utilities\.css does not define/);
  }, 30_000);

  it('refuses an app with no Icon.svelte rather than listing a glyphless tile', async () => {
    await expect(
      renderAppIcons({ root, appsDir, apps: [{ id: 'no-such-app', fg: undefined }] })
    ).rejects.toThrow(/has no Icon\.svelte/);
  });
});
