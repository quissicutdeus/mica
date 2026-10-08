// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Types for `zip.js`, a plain JS build module, covering what the tests import. */

export declare function createZip(
  entries: Array<{ path: string; data: Buffer | string }>,
  options: { mtime: Date }
): Buffer;
