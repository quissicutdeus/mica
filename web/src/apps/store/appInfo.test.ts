// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
/**
 * MICA-172: which facet set this file's subject resolves against. The in-process set
 * now lives in `web/src/host/`, outside the SDK, and `sdk/index.ts` no longer pulls it in
 * on a test's behalf — a package cannot import its consumer. A test file is its own entry
 * point, so it says which side it stands in for: in-process, standing in for the shell.
 */
import '../../host/registerFacets';
import { describe, it, expect } from 'vitest';
import { ALL_PERMISSIONS, type AppPermission } from '../../../../sdk/manifest';
import { addedPermissions, formatPermission } from './appInfo';

import en from './locales/en.json';
import de from './locales/de.json';

/**
 * Manual-check substitute for Step 8 of task-8: rather than opening the Store in dev and
 * clicking through every add-on's details, prove no permission name falls through to the
 * `formatPermission` fallback (which returns the raw name and the gear icon) by checking
 * every name in the vocabulary has a label in the catalog.
 *
 * MICA-217 moved the labels out of a TypeScript table and into the Store's catalog, so
 * the check is against **every locale the Store ships**, not just English: a locale missing
 * one falls back to English silently through `t`, which is exactly the leftover this ticket
 * was about. `formatPermission` itself is exercised with a real translator to prove the key
 * it builds is the one the catalog holds.
 */
describe('formatPermission', () => {
  const catalogs: Record<string, Record<string, string>> = { en, de };

  it.each(Object.keys(catalogs))(
    'gives every permission in the vocabulary a %s label, never the raw name',
    (locale) => {
      const missing = ALL_PERMISSIONS.filter((perm) => !catalogs[locale][`permission.${perm}`]);
      expect(missing, `no store.permission.* entry in ${locale}.json`).toEqual([]);
    }
  );

  it('reads the label through the translator it is handed', () => {
    const translate = (key: string) => (key === 'store.permission.camera' ? 'Kamera' : key);
    expect(formatPermission('camera', translate)).toEqual({ label: 'Kamera', icon: '\u{1F4F7}' });
  });

  it('falls through to the raw name and a gear for a permission the catalog has no word for', () => {
    const untranslated = (key: string) => key;
    expect(formatPermission('unheard-of' as AppPermission, untranslated)).toEqual({
      label: 'unheard-of',
      icon: '\u{2699}\u{FE0F}'
    });
  });
});

/**
 * MICA-196/-201: what decides whether a player is asked before an update installs.
 *
 * The held set is the shell's **grant** now, not the installed manifest — what the player
 * answered rather than what the bundle asked for — so this is a set difference and nothing
 * more. Wrong in the generous direction it prompts on every update, which trains the
 * answer; wrong the other way it installs a wider disclosure in one tap.
 */
describe('addedPermissions', () => {
  const installed = (permissions?: AppPermission[]): AppPermission[] | undefined => permissions;

  it('names only what the entry adds, in the order the catalog wrote it', () => {
    expect(
      addedPermissions(installed(['storage']), { permissions: ['storage', 'contacts', 'messages'] })
    ).toEqual(['contacts', 'messages']);
  });

  it('is empty when the entry asks for no more than is held', () => {
    expect(
      addedPermissions(installed(['storage', 'contacts']), { permissions: ['storage'] })
    ).toEqual([]);
    expect(addedPermissions(installed(['storage']), { permissions: ['storage'] })).toEqual([]);
  });

  it('treats an add-on with no grant as holding none, not as holding everything', () => {
    // An add-on installed reading nothing is the one a republished, grabbier version does
    // the most damage to, so the absent case must not read as "already agreed".
    expect(addedPermissions(installed(), { permissions: ['contacts'] })).toEqual(['contacts']);
  });

  it('adds nothing for an entry that asks for nothing', () => {
    expect(addedPermissions(installed(['contacts']), { permissions: [] })).toEqual([]);
  });
});
