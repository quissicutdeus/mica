// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Types for `check-test-types.js`, a plain JS script, covering what its test imports. */

export declare function parseBaseline(text: string): string[];
export declare function parseTscOutput(output: string): {
  byFile: Map<string, string[]>;
  unlocated: string[];
};
export declare function judge(
  failing: Set<string>,
  baseline: string[],
  exists: (path: string) => boolean
): string[];
