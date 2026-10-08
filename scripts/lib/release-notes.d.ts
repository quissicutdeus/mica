// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Types for `release-notes.js`, a plain JS build module, covering what the tests import. */

export declare const MAX_ENTRY_CHARS: number;
export declare const NOTHING_FOR_OWNER: string;
export declare function parseSections(
  changelogText: string
): Array<{ heading: string; body: string }>;
export declare function resolveSection(
  tag: string,
  changelogText: string
): { coverage: 'dated' | 'unreleased' | 'none'; body: string };
export declare function capEntry(body: string, tag: string, repo: string, max?: number): string;
export declare function releaseNotesFor(tag: string, changelogText: string, repo?: string): string;
