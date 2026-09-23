// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
// MICA-176: jsdom because this file's subject now transitively imports `services/admin.ts`,
// which reads `window` at module scope. Not a workaround for `isBrowser()`, and do not
// "simplify" this line away by giving that predicate a `typeof` guard — MICA-177 is the
// bug and carries the reasoning, including why both cheap guards are worse than the crash.
/**
 * MICA-176: which facet set this file's subject resolves against. A hook no longer
 * carries its facet — `src/main.ts` picks the in-process set for the shell and `bootAddOn`
 * picks the iframe twins for an add-on — so a test file, having neither entry point, says
 * which side it is standing in for. In-process, because a unit test stands in for the shell.
 */
import '../../host/registerFacets';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { get } from 'svelte/store';
import { DEVICES } from '@mica/shared/devices';
import { setActiveDevice } from './device';
import { ownerConfig } from './ownerConfig';
import { DEFAULT_DOCK_APP_IDS, dockAppIds, sanitizeDockAppIds, setDockSlot } from './dock';
import { storage } from '../../host/facets/storage';
import { persistedRehydratorsAll } from '../../../../sdk/host/seam/persistedRegistry';

/**
 * MICA-287: mocked here (this file previously let `setItem`/`removeItem` reach the real
 * `services/settings` transport, harmlessly, since nothing asserted on it) so the new
 * "owner default after a character switch" test below can drive the sweeping hydrate with
 * two different, explicitly successful answers — the distinction a rejected fetch and an
 * empty-but-real one now carry (`host/facets/storage.ts`).
 */
const serviceMock = vi.hoisted(() => ({
  fetchSettings: vi.fn().mockResolvedValue([]),
  saveSetting: vi.fn(),
  removeSetting: vi.fn(),
  clearAppSettings: vi.fn()
}));
vi.mock('../../services/settings', () => serviceMock);

import { hydrateSettingsOnCharacterLoad } from '../../host/facets/storage';

describe('Dock state', () => {
  beforeEach(() => {
    dockAppIds.set([...DEFAULT_DOCK_APP_IDS]);
  });

  it('defaults to phone, messages, media, camera in order', () => {
    expect(get(dockAppIds)).toEqual(['phone', 'messages', 'media', 'camera']);
  });

  describe('sanitizeDockAppIds', () => {
    it('falls back to the default for non-array garbage', () => {
      expect(sanitizeDockAppIds(null)).toEqual(DEFAULT_DOCK_APP_IDS);
      expect(sanitizeDockAppIds('nope')).toEqual(DEFAULT_DOCK_APP_IDS);
      expect(sanitizeDockAppIds(42)).toEqual(DEFAULT_DOCK_APP_IDS);
    });

    it('caps at four slots, padding with empty strings', () => {
      expect(sanitizeDockAppIds(['a'])).toEqual(['a', '', '', '']);
      expect(sanitizeDockAppIds(['a', 'b', 'c', 'd', 'e'])).toEqual(['a', 'b', 'c', 'd']);
    });

    it('drops non-string entries and blanks duplicates rather than collapsing the array', () => {
      expect(sanitizeDockAppIds(['a', 5, 'b'])).toEqual(['a', 'b', '', '']);
      expect(sanitizeDockAppIds(['a', 'a', 'b'])).toEqual(['a', '', 'b', '']);
    });

    it('sizes and defaults by device: six slots on the tablet, Admin and Settings first', () => {
      const tablet = DEVICES.tablet;
      expect(sanitizeDockAppIds(null, tablet)).toEqual(['admin', 'settings', '', '', '', '']);
      expect(sanitizeDockAppIds(['a', 'b', 'c', 'd', 'e', 'f', 'g'], tablet)).toEqual([
        'a',
        'b',
        'c',
        'd',
        'e',
        'f'
      ]);
    });

    it('tolerates an id the registry has not confirmed yet — it is not filtered out', () => {
      expect(sanitizeDockAppIds(['some_addon_not_yet_hydrated'])).toEqual([
        'some_addon_not_yet_hydrated',
        '',
        '',
        ''
      ]);
    });
  });

  describe('setDockSlot', () => {
    it('replaces one slot without touching the others', () => {
      setDockSlot(1, 'notes');
      expect(get(dockAppIds)).toEqual(['phone', 'notes', 'media', 'camera']);
    });

    it('moves an app rather than duplicating it across two slots', () => {
      setDockSlot(3, 'phone');
      expect(get(dockAppIds)).toEqual(['', 'messages', 'media', 'phone']);
    });

    it('ignores an out-of-range index', () => {
      setDockSlot(4, 'notes');
      expect(get(dockAppIds)).toEqual(DEFAULT_DOCK_APP_IDS);
    });
  });

  describe('the owner default dock (MICA-234)', () => {
    const settingsStorage = storage('settings');

    afterEach(() => {
      ownerConfig.set({ disabledApps: [], defaultDock: [] });
      setActiveDevice('phone');
    });

    it('fills a dock nothing has been saved to yet, once the owner answer arrives', () => {
      // `beforeEach` above already called `dockAppIds.set(...)`, which persists — so this
      // is the async-arrival race the store's own doc describes: `perDevice` has already
      // written the built-in default by the time the config answer lands, and only the
      // storage key, not that in-memory value, says whether the player has one of their
      // own. Clearing it here stands in for a player who never has.
      settingsStorage.removeItem('dockAppIds');
      ownerConfig.set({ disabledApps: [], defaultDock: ['bank', '', 'notes', ''] });
      expect(get(dockAppIds)).toEqual(['bank', '', 'notes', '']);
    });

    it('never overwrites a dock the player has already saved', () => {
      setDockSlot(1, 'notes');
      ownerConfig.set({ disabledApps: [], defaultDock: ['bank', 'camera', 'weather', 'mail'] });
      expect(get(dockAppIds)).toEqual(['phone', 'notes', 'media', 'camera']);
    });

    it('applies only to the phone, which the convar configures — never the tablet', () => {
      setActiveDevice('tablet');
      const before = get(dockAppIds);
      ownerConfig.set({ disabledApps: [], defaultDock: ['bank', '', '', ''] });
      expect(get(dockAppIds)).toEqual(before);
    });

    it('is a no-op with an unset convar', () => {
      settingsStorage.removeItem('dockAppIds');
      const before = get(dockAppIds);
      ownerConfig.set({ disabledApps: [], defaultDock: [] });
      expect(get(dockAppIds)).toEqual(before);
    });

    /**
     * The reply-order bug this overlay replaced: `ownerConfig.subscribe` used to write the
     * owner's default straight into storage the first time it saw an empty dock, which both
     * queued a debounced server save and made the *next* answer, whichever it was, race that
     * queued save. These two prove the fix from both ends — the default never leaves a mark
     * to race against, and a rehydrated dock wins regardless of which of the two lands second.
     */
    it('shows the owner default without writing it — there is nothing for a later rehydrate to race', () => {
      settingsStorage.removeItem('dockAppIds');
      ownerConfig.set({ disabledApps: [], defaultDock: ['bank', '', 'notes', ''] });
      expect(get(dockAppIds)).toEqual(['bank', '', 'notes', '']);
      expect(settingsStorage.getItem('dockAppIds')).toBeNull();

      // The player's real dock, landing the way a settings rehydrate actually writes it:
      // straight into storage, then every persisted store re-reads its own key.
      settingsStorage.setItem('dockAppIds', ['weather', '', '', '']);
      for (const rehydrate of persistedRehydratorsAll()) rehydrate();
      expect(get(dockAppIds)).toEqual(['weather', '', '', '']);
    });

    it('a rehydrated dock landing before the owner answer still wins', () => {
      settingsStorage.removeItem('dockAppIds');
      settingsStorage.setItem('dockAppIds', ['weather', '', '', '']);
      for (const rehydrate of persistedRehydratorsAll()) rehydrate();
      expect(get(dockAppIds)).toEqual(['weather', '', '', '']);

      ownerConfig.set({ disabledApps: [], defaultDock: ['bank', '', 'notes', ''] });
      expect(get(dockAppIds)).toEqual(['weather', '', '', '']);
    });

    /**
     * MICA-287: `hasStoredPhoneDock`'s own doc names this exact failure — the previous
     * character's `dockAppIds` sitting in the shared local cache made a fresh character
     * with no dock of their own look like they already had one, so the owner default never
     * showed. Driven through the real `hydrateSettingsOnCharacterLoad` — the sweeping,
     * character-load hydrate (round 3 moved the sweep out of the sdk seam's plain
     * `hydrateSettings()`, which stays additive-only) — not a manual storage write, so this
     * exercises the sweep in `host/facets/storage.ts` and not just `dockOverlay`'s own
     * derived logic.
     */
    it('MICA-287: shows the owner default for a fresh character after a switch, not the previous one’s dock', async () => {
      // `beforeEach` above's `dockAppIds.set(...)` queued a debounced write for this same
      // key that has not flushed yet — a key with a write still pending is protected from
      // the hydrate below on purpose (round 3, finding 3), so it has to be cleared first
      // or the hydrate would (correctly) refuse to touch it and this test would prove
      // nothing. `removeItem` cancels the pending write synchronously, the same way the
      // existing tests above use it to stand in for "nothing saved yet".
      settingsStorage.removeItem('dockAppIds');

      // Character A had a dock of their own.
      serviceMock.fetchSettings.mockResolvedValueOnce([
        { app: 'settings', setting_key: 'dockAppIds', setting_value: '["weather","","",""]' }
      ]);
      await hydrateSettingsOnCharacterLoad();
      expect(get(dockAppIds)).toEqual(['weather', '', '', '']);

      ownerConfig.set({ disabledApps: [], defaultDock: ['bank', '', 'notes', ''] });

      // Character B has no dock row at all — a genuinely successful, empty answer, not a
      // failed fetch. Without the sweep, `weather` would still be sitting under the
      // settings app's `dockAppIds` key and `hasStoredPhoneDock` would see a key that was
      // never this character's.
      serviceMock.fetchSettings.mockResolvedValueOnce([]);
      await hydrateSettingsOnCharacterLoad();

      expect(get(dockAppIds)).toEqual(['bank', '', 'notes', '']);
    });
  });
});
