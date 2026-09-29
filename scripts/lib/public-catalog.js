// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * The project's public add-on catalog (MICA-237), as opposed to the demo's own.
 *
 * A stock server's Store points at `https://mica.gg/addons/sdk-<contract>/catalog.json`
 * (`shared/addonConfig.ts`). That URL is the single statement of where the file lives, so
 * the on-disk path is read back out of it here rather than spelled a second time: a
 * catalog written under a path the default URL does not name is a Store that is empty
 * everywhere and green everywhere.
 *
 * It lists only add-ons the resource does NOT already ship. The resource carries every
 * in-tree add-on bundle (`dist/web/addons`), so a default catalog that listed one would
 * offer a remote copy of an app the phone already has and let it replace the bundled one.
 * Today every in-tree add-on ships, so the catalog is an empty array -- computed, not
 * hard-coded, so the day one stops shipping this notices without anyone editing it.
 *
 * Kept apart from `generate-catalog.js` so it can be tested without a built `dist/`.
 * It throws rather than exiting, and the generator turns that into its own refusal.
 */

/**
 * Where, under the served site root, a public catalog URL is stored.
 *
 * Throws on a URL that is not `https` on the public host's path form, because a relative
 * or off-site answer would write the file somewhere nothing serves it.
 */
export const publicCatalogPath = (catalogUrl) => {
  const url = new URL(catalogUrl);
  if (url.protocol !== 'https:' || !/^\/addons\/sdk-[^/]+\/catalog\.json$/.test(url.pathname)) {
    throw new Error(
      `public catalog URL ${catalogUrl} is not https://<host>/addons/sdk-<contract>/catalog.json, ` +
        'so there is no place under the site root that serves it.'
    );
  }
  return url.pathname.slice(1);
};

/**
 * The in-tree add-ons the resource does not ship: those with no bundle in the resource's
 * own bundle directory. `hasBundle` answers for one id; it is a parameter so the rule is
 * testable without a directory.
 */
export const publicAddonIds = (ids, hasBundle) => ids.filter((id) => !hasBundle(id));

/**
 * Write the public catalog under `siteDir` and return the path it went to.
 *
 * A non-empty list is refused. Hosting a public bundle needs a home for it beside the
 * catalog (`addons/sdk-<contract>/<id>.js`), a hash computed from those bytes, and a
 * `bundleUrl` on the public host -- none of which exists, and writing entries whose
 * `bundleUrl` points at the demo's copy would install a bundle from the wrong place. So
 * the day an add-on stops shipping in the resource this fails the image build, which is
 * where somebody has to build that half, rather than shipping a catalog that lies.
 */
export const writePublicCatalog = ({ siteDir, catalogUrl, ids, bundleDir }) => {
  const stray = publicAddonIds(ids, (id) => existsSync(join(bundleDir, `${id}.js`)));
  if (stray.length > 0) {
    throw new Error(
      `${stray.join(', ')} ${stray.length === 1 ? 'has' : 'have'} no bundle in ${bundleDir}, so the ` +
        `resource does not ship ${stray.length === 1 ? 'it' : 'them'} and the public catalog would ` +
        'list them -- but nothing builds a public bundle yet. Build the add-ons first, or ' +
        'teach this to host one.'
    );
  }
  const file = join(siteDir, publicCatalogPath(catalogUrl));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify([], null, 2)}\n`);
  return file;
};
