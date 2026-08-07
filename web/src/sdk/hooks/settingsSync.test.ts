// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { get } from 'svelte/store';

const serviceMock = vi.hoisted(() => ({
  fetchSettings: vi.fn(),
  saveSetting: vi.fn(),
  removeSetting: vi.fn(),
  clearAppSettings: vi.fn()
}));
vi.mock('../../services/settings', () => serviceMock);

import { usePersisted } from './usePersisted';
import { clearAppStorage, hydrateSettings, useStorage } from './useStorage';
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
});
