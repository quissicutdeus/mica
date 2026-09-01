// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Types for `addon-ids.js`, which is plain JS so `build-addons.mjs` can import it too.
 *
 * This file is the "proper JS module type support" that `vite.addon.config.ts`'s old comment
 * said was the right fix if the two copies ever drifted (MICA-190). Without it,
 * `tsc -p tsconfig.node.json` rejects the import with `TS7016`.
 */

export declare const withoutComments: (source: string) => string;
export declare function coreValueOf(source: string): boolean | null;
export declare function addOnIds(appsDir: string): string[];
