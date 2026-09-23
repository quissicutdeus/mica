// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
/**
 * MICA-176: which facet set this file's subject resolves against. A hook no longer
 * carries its facet — `src/main.ts` picks the in-process set for the shell and `bootAddOn`
 * picks the iframe twins for an add-on — so a test file, having neither entry point, says
 * which side it is standing in for. In-process, because a unit test stands in for the shell.
 */
import '../../host/registerFacets';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { get } from 'svelte/store';

const serviceMock = vi.hoisted(() => ({
  fetchSettings: vi.fn(),
  saveSetting: vi.fn(),
  removeSetting: vi.fn(),
  clearAppSettings: vi.fn()
}));
vi.mock('../../services/settings', () => serviceMock);

import { clearAppStorage } from '../../../../sdk/host/useStorage';
import { appDrawerHintSeen, migrateAppDrawerHintForExistingSaves } from './onboarding';

describe('App Drawer first-run hint migration', () => {
  beforeEach(() => {
    clearAppStorage('settings');
    vi.clearAllMocks();
    serviceMock.fetchSettings.mockResolvedValue([]);
  });

  it('leaves the hint unseen for a character with zero settings rows (true fresh install)', async () => {
    serviceMock.fetchSettings.mockResolvedValue([]);
    await migrateAppDrawerHintForExistingSaves();
    expect(get(appDrawerHintSeen)).toBe(false);
  });

  it('marks the hint seen for a character with unrelated settings already saved', async () => {
    serviceMock.fetchSettings.mockResolvedValue([
      { app: 'settings', setting_key: 'theme', setting_value: '"dark"' }
    ]);
    await migrateAppDrawerHintForExistingSaves();
    expect(get(appDrawerHintSeen)).toBe(true);
  });

  it('does nothing once an explicit appDrawerHintSeen row already exists', async () => {
    appDrawerHintSeen.set(false);
    serviceMock.fetchSettings.mockResolvedValue([
      { app: 'settings', setting_key: 'appDrawerHintSeen', setting_value: 'false' }
    ]);
    await migrateAppDrawerHintForExistingSaves();
    expect(get(appDrawerHintSeen)).toBe(false);
  });

  it('is a no-op once already seen', async () => {
    appDrawerHintSeen.set(true);
    await migrateAppDrawerHintForExistingSaves();
    expect(serviceMock.fetchSettings).not.toHaveBeenCalled();
  });

  /**
   * MICA-287: `fetchSettings` now rejects instead of resolving `[]` on a failed request,
   * including the routine "Player not authenticated" reply this call site can genuinely
   * race — it chains directly off the very first, boot-time hydrate in `Shell.svelte`,
   * with no guarantee a character has loaded by the time that settles. A rejection here
   * must resolve quietly, or it is an unhandled one the e2e page-error check or CEF sees.
   */
  it('skips quietly on a failed fetch, rather than leaving an unhandled rejection', async () => {
    serviceMock.fetchSettings.mockRejectedValue(new Error('Player not authenticated'));
    await expect(migrateAppDrawerHintForExistingSaves()).resolves.toBeUndefined();
    expect(get(appDrawerHintSeen)).toBe(false);
  });
});
