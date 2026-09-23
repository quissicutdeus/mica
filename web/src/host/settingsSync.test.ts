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
import './registerFacets';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { get } from 'svelte/store';

const serviceMock = vi.hoisted(() => ({
  fetchSettings: vi.fn(),
  saveSetting: vi.fn(),
  removeSetting: vi.fn(),
  clearAppSettings: vi.fn()
}));
vi.mock('../services/settings', () => serviceMock);

import { usePersisted } from '../../../sdk/host/usePersisted';
import { clearAppStorage, hydrateSettings, useStorage } from '../../../sdk/host/useStorage';
import { hydrateSettingsOnCharacterLoad } from './facets/storage';
import { __resetSettingsSync } from './settingsSync';

/**
 * The contract that lets every existing `useStorage` call site keep working.
 *
 * The API is synchronous and `usePersisted` reads its key **once**, at module scope on a
 * page CEF never unloads. So localStorage stops being the authority and becomes a cache:
 * reads stay sync, the server is truth, and the interesting behavior is all in what
 * happens when the two disagree.
 */
describe('server-backed storage', () => {
  beforeEach(() => {
    /**
     * Through `clearAppStorage`, not `localStorage.clear()`.
     *
     * Node reports `localStorage is not available` without `--localstorage-file`, so
     * `useStorage` is running on its in-memory fallback here — which is module scope and
     * would otherwise carry values between cases. `clearAppStorage` sweeps whichever
     * backend is live, which is also the only way this suite stays correct if the
     * environment ever gains a real one.
     */
    for (const namespace of ['settings', 'snake']) clearAppStorage(namespace);

    vi.clearAllMocks();
    __resetSettingsSync();
    serviceMock.fetchSettings.mockResolvedValue([]);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes through to the server, debounced per key', async () => {
    const storage = useStorage('settings');

    // A slider drag: many writes to one key in one gesture.
    storage.setItem('displaySize', 10);
    storage.setItem('displaySize', 20);
    storage.setItem('displaySize', 30);

    // Local is immediate — the phone reads the cache, so it must not wait on a round trip.
    expect(storage.getItem('displaySize')).toBe(30);
    expect(serviceMock.saveSetting).not.toHaveBeenCalled();

    await vi.runAllTimersAsync();

    expect(serviceMock.saveSetting).toHaveBeenCalledTimes(1);
    expect(serviceMock.saveSetting).toHaveBeenCalledWith('settings', 'displaySize', '30');
  });

  it('does not let one key delay another', async () => {
    // Debounced per key, not globally: a slider drag must not hold up a toggle the player
    // flipped in the same second.
    const storage = useStorage('settings');
    storage.setItem('displaySize', 30);
    storage.setItem('bluetooth_enabled', false);

    await vi.runAllTimersAsync();

    expect(serviceMock.saveSetting).toHaveBeenCalledTimes(2);
  });

  it('hydration replaces the cache and re-reads live stores', async () => {
    const store = usePersisted<string>('settings', 'greeting', 'default');
    expect(get(store)).toBe('default');

    serviceMock.fetchSettings.mockResolvedValue([
      { app: 'settings', setting_key: 'greeting', setting_value: '"from the server"' }
    ]);

    await hydrateSettings();

    // Both halves matter. The cache alone would leave the old value on screen for the
    // rest of the session, because the store read its key once at construction.
    expect(get(store)).toBe('from the server');
    expect(useStorage('settings').getItem('greeting')).toBe('from the server');
  });

  it('hydration does not write back what it just read', async () => {
    usePersisted<string>('settings', 'greeting', 'default');
    serviceMock.fetchSettings.mockResolvedValue([
      { app: 'settings', setting_key: 'greeting', setting_value: '"from the server"' }
    ]);

    await hydrateSettings();
    await vi.runAllTimersAsync();

    // Rehydrating through the persisting `set` would echo the server's own value straight
    // back at it — one useless write per key per character load.
    expect(serviceMock.saveSetting).not.toHaveBeenCalled();
  });

  it('a failed fetch keeps the phone as it was', async () => {
    const store = usePersisted<string>('settings', 'greeting', 'default');
    store.set('chosen by the player');
    serviceMock.fetchSettings.mockRejectedValue(new Error('offline'));

    await hydrateSettings();

    // Resetting a working phone to defaults because one request timed out is worse than
    // showing a value that might be stale.
    expect(get(store)).toBe('chosen by the player');
  });

  it('a store with sync: false never leaves the phone', async () => {
    // The wallpaper case: a base64 data URL of unbounded size would put megabytes across
    // the bridge on every color change.
    const store = usePersisted<string>('settings', 'wallpaper', 'none', { sync: false });
    store.set('url(data:image/png;base64,AAAA)');

    await vi.runAllTimersAsync();

    expect(serviceMock.saveSetting).not.toHaveBeenCalled();
    // Still local, though — the preference works, it just does not follow the character.
    expect(get(store)).toBe('url(data:image/png;base64,AAAA)');
  });

  it('hydration cannot overwrite an unsynced key', async () => {
    const store = usePersisted<string>('settings', 'wallpaper', 'none', { sync: false });
    store.set('local choice');

    // A row that should not exist — from an older client, or another machine. The opt-out
    // has to hold on the way in as well as on the way out, or the exception is one-way.
    serviceMock.fetchSettings.mockResolvedValue([
      { app: 'settings', setting_key: 'wallpaper', setting_value: '"someone elses"' }
    ]);

    await hydrateSettings();

    expect(get(store)).toBe('local choice');
  });

  it('clearing an app clears it on the server too', async () => {
    clearAppStorage('snake');

    // Otherwise the rows outlive the uninstall and come back on the next hydrate, which
    // is the resurrection `clearAppStorage` exists to prevent.
    expect(serviceMock.clearAppSettings).toHaveBeenCalledWith('snake');
  });

  it('removing a key removes it on the server, immediately', async () => {
    const storage = useStorage('settings');
    storage.setItem('greeting', 'hi');
    storage.removeItem('greeting');

    await vi.runAllTimersAsync();

    expect(serviceMock.removeSetting).toHaveBeenCalledWith('settings', 'greeting');
    // The pending write for that key is dropped rather than landing after the delete and
    // resurrecting it.
    expect(serviceMock.saveSetting).not.toHaveBeenCalled();
  });

  /**
   * MICA-287 round 3: the sdk seam's `hydrateSettings()` — what runs at page load — must
   * stay purely additive. Round 1 put the sweep in this same function and shipped it
   * through review: the dev/e2e mock's `settings:getAll` starts empty and answers `[]` on
   * every page load with no concept of "not authenticated" to reject on, so the sweep
   * deleted every seeded `mica:*` key on first paint, in `pnpm dev`, the demo container and
   * most of the e2e suite. The sweeping half now only exists in
   * `hydrateSettingsOnCharacterLoad`, below, which the page-load path never reaches.
   */
  it('a page-load hydrate answering [] removes nothing', async () => {
    const storage = useStorage('settings');
    storage.setItem('greeting', 'seeded before this page load');

    serviceMock.fetchSettings.mockResolvedValueOnce([]);
    await hydrateSettings();

    expect(storage.getItem('greeting')).toBe('seeded before this page load');
  });

  /**
   * `hydrateSettingsOnCharacterLoad` (`host/facets/storage.ts`) is the sweeping half MICA-287
   * round 1 wrongly put in the page-load path. It is reached only from a real character-load
   * signal — `nuiMessages.ts`'s `rehydrateSettings` and `rehydrateShell` routes
   * (`nuiMessages.test.ts` covers that wiring) — never from the sdk seam's
   * `hydrateSettings()` above.
   */
  describe('the character-load hydrate (MICA-287)', () => {
    it('clears a setting the new character has no row for, and the live store re-reads', async () => {
      const store = usePersisted<string>('settings', 'greeting', 'default');

      serviceMock.fetchSettings.mockResolvedValueOnce([
        { app: 'settings', setting_key: 'greeting', setting_value: '"character A"' }
      ]);
      await hydrateSettingsOnCharacterLoad();
      expect(get(store)).toBe('character A');

      // Character B's answer is a genuinely successful, empty one — not a failure. `[]`
      // here must mean "no rows", or the sweep below could never fire on a real answer.
      serviceMock.fetchSettings.mockResolvedValueOnce([]);
      await hydrateSettingsOnCharacterLoad();

      expect(get(store)).toBe('default');
      expect(useStorage('settings').getItem('greeting')).toBeNull();
    });

    it('does not carry one character’s value into the next character’s store', async () => {
      const store = usePersisted<string>('settings', 'theme', 'light');

      serviceMock.fetchSettings.mockResolvedValueOnce([
        { app: 'settings', setting_key: 'theme', setting_value: '"dark"' }
      ]);
      await hydrateSettingsOnCharacterLoad();
      expect(get(store)).toBe('dark');

      serviceMock.fetchSettings.mockResolvedValueOnce([
        { app: 'settings', setting_key: 'theme', setting_value: '"amoled"' }
      ]);
      await hydrateSettingsOnCharacterLoad();
      expect(get(store)).toBe('amoled');

      // A third character with no row at all sees neither predecessor's value.
      serviceMock.fetchSettings.mockResolvedValueOnce([]);
      await hydrateSettingsOnCharacterLoad();
      expect(get(store)).toBe('light');
    });

    it('does not clear an unsynced key just because the new answer omits it', async () => {
      // Unsynced keys never had a server row to begin with (the wallpaper case above) —
      // their absence from an answer says nothing about which character is loaded.
      const store = usePersisted<string>('settings', 'wallpaper', 'none', { sync: false });
      store.set('local choice');

      serviceMock.fetchSettings.mockResolvedValueOnce([]);
      await hydrateSettingsOnCharacterLoad();

      expect(get(store)).toBe('local choice');
    });

    /**
     * MICA-287 round 3: this ticket's first attempt cancelled every pending write before
     * sweeping, on the theory that a switch happens seconds apart from any edit. qbx fires
     * both of its player-loaded events for one real load, so this function runs twice in a
     * row with no switch at all — and the second run's cancel dropped whatever the player
     * had changed in the ~400ms since the first. The fix is not to cancel: a key with a
     * write still queued is simply excluded from both the sweep and the write below, since
     * the local value is newer than anything the server could have answered with.
     */
    it('a key with a pending write survives a rehydrate, and so does its local value', async () => {
      const storage = useStorage('settings');
      // Not yet flushed — still inside the 400ms debounce when the rehydrate lands.
      storage.setItem('greeting', 'chosen mid-drag');

      // The server's answer has no row for it yet, precisely because the write is still
      // in flight — a sweep with no pending-write guard would read this as "cleared".
      serviceMock.fetchSettings.mockResolvedValueOnce([]);
      await hydrateSettingsOnCharacterLoad();

      expect(storage.getItem('greeting')).toBe('chosen mid-drag');

      // And the write itself still lands — nothing cancelled it.
      await vi.runAllTimersAsync();
      expect(serviceMock.saveSetting).toHaveBeenCalledWith(
        'settings',
        'greeting',
        '"chosen mid-drag"'
      );
    });

    it('does not overwrite a pending write with a stale answer for the same key', async () => {
      const store = usePersisted<string>('settings', 'greeting', 'default');
      store.set('chosen mid-drag');

      // The server's row still holds whatever was there before this edit queued.
      serviceMock.fetchSettings.mockResolvedValueOnce([
        { app: 'settings', setting_key: 'greeting', setting_value: '"stale server value"' }
      ]);
      await hydrateSettingsOnCharacterLoad();

      expect(get(store)).toBe('chosen mid-drag');
    });

    it('treats "Player not authenticated" as the expected pre-character reply, without logging', async () => {
      const store = usePersisted<string>('settings', 'greeting', 'default');
      store.set('chosen by the player');
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      serviceMock.fetchSettings.mockRejectedValueOnce(new Error('Player not authenticated'));
      await hydrateSettingsOnCharacterLoad();

      // A failure, even the routine boot-time one, may never clear what was already there.
      expect(get(store)).toBe('chosen by the player');
      expect(errorSpy).not.toHaveBeenCalled();

      errorSpy.mockRestore();
    });

    it('still logs a failure that is not the expected pre-character reply', async () => {
      const store = usePersisted<string>('settings', 'greeting', 'default');
      store.set('chosen by the player');
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      serviceMock.fetchSettings.mockRejectedValueOnce(new Error('offline'));
      await hydrateSettingsOnCharacterLoad();

      expect(get(store)).toBe('chosen by the player');
      expect(errorSpy).toHaveBeenCalled();

      errorSpy.mockRestore();
    });
  });

  /**
   * MICA-287 round 3: an add-on marks its own `sync: false` keys unsynced only when its
   * frame boots (`sdk/host/iframe/facets/persisted.ts`, over a `remoteCall`), and an add-on
   * is opened on demand — not necessarily before the next character-load sweep, possibly
   * not even this session at all. Persisting the mark on the device is what lets a fresh
   * module instance (a page reload) already know, with no `markUnsynced` call of its own.
   */
  describe('the unsynced record survives a fresh module instance', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('an add-on marked unsynced in an earlier session stays unsynced with no markUnsynced call this time', async () => {
      // A real, persistent backing — `vi.resetModules()` clears the module cache, not this
      // object, which is exactly what a device's actual localStorage does across a reload.
      const backing: Record<string, string> = {};
      vi.stubGlobal('localStorage', {
        getItem: (key: string) => backing[key] ?? null,
        setItem: (key: string, value: string) => {
          backing[key] = value;
        },
        removeItem: (key: string) => {
          delete backing[key];
        }
      });

      const firstSession = await import('./settingsSync');
      firstSession.markUnsynced('blabber', 'wallpaper');

      vi.resetModules();
      const secondSession = await import('./settingsSync');

      // No `markUnsynced` call on this instance — the add-on has not booted this session —
      // and it already knows, because the record lives on the device, not in module state.
      expect(secondSession.isUnsynced('blabber', 'wallpaper')).toBe(true);
    });
  });
});
