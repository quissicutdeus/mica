// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const { dbMock } = vi.hoisted(() => ({
  dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() }
}));
vi.mock('../lib/Database', () => ({ Database: dbMock }));

// The whole barrel, so the categories are every owned table a server with every service has.
import '../services';
import { exportCategories } from '../services/Privacy';

/**
 * MICA-168: every category the export can return has a label in both Settings catalogs.
 *
 * The categories are derived from the service declarations, so a service that declares a
 * table adds a category without touching the web. This is what notices: an unlabelled one
 * would render as its raw table name in the Your data pane.
 */
const SETTINGS_LOCALES = join(__dirname, '..', '..', 'web', 'src', 'apps', 'settings', 'locales');

const catalog = (lang: string): Record<string, string> =>
  JSON.parse(readFileSync(join(SETTINGS_LOCALES, `${lang}.json`), 'utf8'));

describe('export category labels', () => {
  const categories = exportCategories();

  it('finds categories to check at all', () => {
    expect(categories.length).toBeGreaterThan(20);
    expect(categories).not.toContain('audit_logs');
  });

  for (const lang of ['en', 'de']) {
    it(`labels every category in ${lang}.json as yourData.cat.<category>`, () => {
      const keys = catalog(lang);
      const missing = categories.filter((c) => typeof keys[`yourData.cat.${c}`] !== 'string');
      expect(missing, `add yourData.cat.<category> to settings/locales/${lang}.json`).toEqual([]);
    });
  }
});
