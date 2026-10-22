// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Types for `localeUsage.js`, a plain JS build module, covering what the tests import. */

import type { LocaleCatalog } from './locales.js';

export interface KeyFamily {
  match: RegExp;
  site: string;
  why: string;
}

export declare const SOURCE_DIRS: readonly string[];
export declare const FAMILIES: readonly KeyFamily[];
export declare function stripComments(text: string): string;
export declare function findUnusedKeys(
  root: string,
  catalogs: Map<string, Map<string, LocaleCatalog>>
): { full: string; path: string }[];
