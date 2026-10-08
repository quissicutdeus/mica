// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Types for `pack-integration.js`, a plain JS build script, covering what the tests import. */

export interface ZipEntry {
  path: string;
  data: Buffer;
}

export type Mode = 'standalone' | 'qbx' | 'esx';

export declare const MODES: readonly Mode[];
export declare function readZip(buffer: Buffer): ZipEntry[];
export declare function assembleRunEntries(
  micaEntries: ZipEntry[],
  integrationEntries: ZipEntry[]
): ZipEntry[];
export declare function scenarioIds(
  files: Array<{ name: string; text: string }>
): Array<{ id: string; mode: string }>;
export declare function expectedScenariosText(
  scenarios: Array<{ id: string; mode: string }>
): string;
