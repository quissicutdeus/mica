// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import fs from 'node:fs';

try {
  fs.rmSync('./dist', { recursive: true, force: true });
} catch (e) {
  console.error('Failed to clear dist folder:', e);
}
