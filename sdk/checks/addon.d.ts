// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Types for `addon.js`, a plain JS check module, covering what the tests import. */

import type { ComputedClass } from './classes';

export type Violation = { file: string; line: number; rule: string; message: string };

export interface CollectedFiles {
  svelte: string[];
  ts: string[];
  css: string[];
}

/** What stylelint hands back for one file: the fields `unparsedStylesheets` reads, and no more. */
export type LintedFile = {
  source?: string;
  ignored?: boolean;
  _postcssResult?: { root?: { type?: string; nodes?: unknown[] } };
};

export declare const SDK_STYLESHEETS: readonly string[];
export declare function readSdkStylesheets(sdkDir?: string): Record<string, string>;
export declare function unparsedStylesheets(
  results: LintedFile[],
  read: (file: string) => string
): string[];
export declare function collectFiles(dirs: string[], cwd: string): CollectedFiles;
export declare function checkAddonSources(
  files: CollectedFiles,
  options: { cwd: string; sdk?: Record<string, string> }
): { violations: Violation[]; computed: ComputedClass[] };
