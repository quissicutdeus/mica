// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Types for `locales.js`, a plain JS build module, covering what the tests import. */

export interface LocaleCatalog {
  path: string;
  entries: Record<string, string>;
}

export declare const LOCALES_DIR: string;
export declare const BUNDLED_LANGS: readonly string[];
export declare function discoverCatalogs(root: string): Map<string, Map<string, LocaleCatalog>>;
export declare function renderLocales(root: string): Promise<Map<string, string>>;
export declare function existingLocales(root: string): Map<string, string>;
export declare function diffLocales(
  expected: Map<string, string>,
  existing: Map<string, string>
): { missing: string[]; changed: string[]; stale: string[] };
