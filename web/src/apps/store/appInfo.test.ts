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
import { ALL_PERMISSIONS, type AppManifest, type AppPermission } from '../../../../sdk/manifest';
import { addedPermissions, formatPermission } from './appInfo';

/**
 * Manual-check substitute for Step 8 of task-8: rather than opening the Store in dev and
 * clicking through every add-on's details, prove no permission name falls through to the
 * `formatPermission` fallback (which returns the raw name and the gear icon) by checking
 * every name in the vocabulary gets an actual label.
 */
describe('formatPermission', () => {
  it('gives every permission in the vocabulary a real label, never the raw name', () => {
    for (const perm of ALL_PERMISSIONS) {
      expect(formatPermission(perm).label, `${perm} fell through to the default`).not.toBe(perm);
    }
  });
});

/**
 * MICA-196: what decides whether a player is asked before an update installs.
 *
 * The installed manifest is the record of what they accepted — `installVerified` builds its
 * `permissions` from the catalog entry, and `AppDetails` shows exactly that list beside the
 * Install button — so this is a set difference and nothing more. Wrong in the generous
 * direction it prompts on every update, which trains the answer; wrong the other way it
 * installs a wider disclosure in one tap.
 */
describe('addedPermissions', () => {
  const installed = (permissions?: AppPermission[]): AppManifest =>
    ({ id: 'probe', name: 'Probe', ...(permissions ? { permissions } : {}) }) as AppManifest;

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

  it('treats an installed app with no permissions as holding none, not as holding everything', () => {
    // An add-on installed reading nothing is the one a republished, grabbier version does
    // the most damage to, so the absent case must not read as "already agreed".
    expect(addedPermissions(installed(), { permissions: ['contacts'] })).toEqual(['contacts']);
  });

  it('adds nothing for an entry that asks for nothing', () => {
    expect(addedPermissions(installed(['contacts']), { permissions: [] })).toEqual([]);
  });
});
