import { describe, it, expect } from 'vitest';
import { get } from 'svelte/store';
import { appStorageBytes, clearAppStorage } from './host/useStorage';
import { usePersisted } from './host/usePersisted';

/**
 * App storage, and what "clear it" has to mean.
 *
 * The namespace sweep was the easy half. The half that was missing is that a persisted store
 * reads its key exactly once, at construction — module scope, on a CEF page that never
 * unloads — so clearing an app's storage under a live store left the old value on screen and
 * let the store's next write put the key straight back. Settings' "clear storage" is sold to
 * a player as returning an app to a freshly installed state, so that gap is the feature.
 *
 * A distinct app id per test rather than a shared one wiped in `beforeEach`: this suite runs
 * against the in-memory backend — jsdom here has no `localStorage`, which is also the
 * fallback the game's CEF exercises — and that map is module state with nothing to reset it.
 * Isolating by namespace is what the namespace is for.
 */
describe('clearAppStorage', () => {
  it('removes only the keys belonging to the app', () => {
    usePersisted('scope_mine', 'kept', 0).set(1);
    usePersisted('scope_other', 'untouched', 0).set(2);

    clearAppStorage('scope_mine');

    expect(appStorageBytes('scope_mine')).toBe(0);
    expect(appStorageBytes('scope_other')).toBeGreaterThan(0);
  });

  it('resets a live persisted store to its shipped default', () => {
    const store = usePersisted('reset_live', 'volume', 10);
    store.set(70);
    expect(get(store)).toBe(70);

    clearAppStorage('reset_live');

    expect(get(store)).toBe(10);
  });

  it('does not recreate the key it just deleted', () => {
    // The reset goes through the inner writable rather than the persisting `set`. Resetting
    // through the public one would write the default back and leave the app with storage
    // immediately after being told it had none.
    usePersisted('reset_nokey', 'volume', 10).set(70);

    clearAppStorage('reset_nokey');

    expect(appStorageBytes('reset_nokey')).toBe(0);
  });

  it('leaves another app’s live store holding its value', () => {
    const mine = usePersisted('bleed_mine', 'n', 0);
    const theirs = usePersisted('bleed_other', 'n', 0);
    mine.set(5);
    theirs.set(9);

    clearAppStorage('bleed_mine');

    expect(get(mine)).toBe(0);
    expect(get(theirs)).toBe(9);
  });

  it('sanitizes the value it resets to, as construction does', () => {
    // A sanitizer is the app's statement of what it will hold. The reset path must go through
    // it too, or clearing can seat a default the app itself would have refused.
    const store = usePersisted<number>('reset_sane', 'step', 999, {
      sanitize: (value) => (typeof value === 'number' && value <= 50 ? value : 50)
    });
    store.set(10);

    clearAppStorage('reset_sane');

    expect(get(store)).toBe(50);
  });

  it('counts the key alongside the value, not the value alone', () => {
    expect(appStorageBytes('bytes_short')).toBe(0);

    /**
     * Compared rather than asserted against a spelled-out key.
     *
     * A namespaced key is `gphone:<appId>:<key>`, which is also the shape of a net event name —
     * so writing one as a literal here trips `eventNames.test.ts`, which scans `web/src` for a
     * borrowed `gphone:` prefix. The property under test is that a longer key costs more for the
     * same value, and that does not need the string.
     */
    usePersisted('bytes_short', 'n', 0).set(1);
    usePersisted('bytes_long', 'nnnnnnnnnn', 0).set(1);

    const short = appStorageBytes('bytes_short');
    const long = appStorageBytes('bytes_long');

    expect(short).toBeGreaterThan(1);
    expect(long - short).toBe(
      'nnnnnnnnnn'.length - 'n'.length + 'bytes_long'.length - 'bytes_short'.length
    );
  });
});
