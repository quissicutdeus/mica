// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Types for `public-catalog.js`, a plain JS build module, covering what the tests import. */

export declare const publicCatalogPath: (catalogUrl: string) => string;
export declare const publicAddonIds: (
  ids: string[],
  hasBundle: (id: string) => boolean
) => string[];
export declare const writePublicCatalog: (options: {
  siteDir: string;
  catalogUrl: string;
  ids: string[];
  bundleDir: string;
}) => string;
