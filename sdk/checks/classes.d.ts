// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Types for `classes.js`, a plain JS check module, covering what the tests import. */

export type ClassUsage = { file: string; line: number; token: string };
export type ComputedClass = { file: string; line: number; expr: string };

export declare function definedClasses(cssTexts: string[]): Set<string>;
export declare function scanClasses(
  source: string,
  rel: string
): { usages: ClassUsage[]; computed: ComputedClass[] };
export declare function componentClasses(
  source: string,
  rel: string
): { usages: ClassUsage[]; computed: ComputedClass[] };
export declare function readTile(
  source: string
): { bg?: string; fg?: string; index: number } | null;
export declare function tileClasses(source: string, rel: string): ClassUsage[];
