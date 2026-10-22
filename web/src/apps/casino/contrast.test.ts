// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * MICA-411: a win in Roulette, Crash and History was `text-green-400`, a palette literal.
 * It does not follow the scheme, so it measured 1.49:1 on the light surface, and no single
 * green passes 4.5:1 on both. Text colour on these screens is a role; the zero pocket's
 * `bg-green-600` under white text is a background and stays.
 */
describe('casino result colours', () => {
  for (const name of ['Roulette', 'Crash', 'History']) {
    it(`${name} draws no text in a palette green`, () => {
      const source = readFileSync(
        fileURLToPath(new URL(`./components/${name}.svelte`, import.meta.url)),
        'utf8'
      );
      expect(source).not.toMatch(/\btext-green-\d+/);
    });
  }
});
