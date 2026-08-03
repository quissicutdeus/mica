import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { usePersisted } from './usePersisted';
import { useStorage, clearAppStorage } from './useStorage';

const storage = useStorage('testapp');

describe('usePersisted', () => {
  beforeEach(() => clearAppStorage('testapp'));

  it('starts at the initial value when nothing is stored', () => {
    expect(get(usePersisted('testapp', 'score', 0))).toBe(0);
  });

  it('reads back what a previous session wrote', () => {
    usePersisted('testapp', 'score', 0).set(42);

    // A fresh store, as a reload would build.
    expect(get(usePersisted('testapp', 'score', 0))).toBe(42);
  });

  it('persists through update as well as set', () => {
    const score = usePersisted('testapp', 'score', 1);
    score.update((n) => n + 1);

    expect(get(score)).toBe(2);
    expect(storage.getItem<number>('score')).toBe(2);
  });

  it('does not create the key just by being constructed', () => {
    // An app that only reads a preference should leave no trace. Writing the default
    // back would also freeze it, so a later change to the default would never reach
    // anyone who had merely opened the app once.
    usePersisted('testapp', 'untouched', 'default');

    expect(storage.getItem('untouched')).toBeNull();
  });

  it('rejects a stored value the app would refuse', () => {
    // The `volumeStep` case: storage outlives the code that wrote it, so a key can come
    // back as something no current version would ever have produced.
    storage.setItem('step', 9999);

    const step = usePersisted('testapp', 'step', 5, {
      sanitize: (v) => ([1, 2, 5].includes(Number(v)) ? Number(v) : 5)
    });

    expect(get(step)).toBe(5);
  });

  it('sanitizes writes too, not just the value read at startup', () => {
    const step = usePersisted('testapp', 'step', 5, {
      sanitize: (v) => ([1, 2, 5].includes(Number(v)) ? Number(v) : 5)
    });

    step.set(9999);

    expect(get(step)).toBe(5);
    expect(storage.getItem<number>('step')).toBe(5);
  });

  it('keeps two apps apart under the same key', () => {
    usePersisted('appA', 'shared', 'a').set('from A');
    usePersisted('appB', 'shared', 'b').set('from B');

    expect(get(usePersisted('appA', 'shared', 'a'))).toBe('from A');
    expect(get(usePersisted('appB', 'shared', 'b'))).toBe('from B');

    clearAppStorage('appA');
    clearAppStorage('appB');
  });
});

describe('clearAppStorage', () => {
  it('removes one app keys and leaves every other app alone', () => {
    // The uninstall path deleted the component and the saved URL but never this, so a
    // reinstall resurrected the old state.
    useStorage('doomed').setItem('a', 1);
    useStorage('doomed').setItem('b', 2);
    useStorage('survivor').setItem('a', 3);

    clearAppStorage('doomed');

    expect(useStorage('doomed').getItem('a')).toBeNull();
    expect(useStorage('doomed').getItem('b')).toBeNull();
    expect(useStorage('survivor').getItem<number>('a')).toBe(3);

    clearAppStorage('survivor');
  });

  it('does not touch an app whose id is a prefix of another', () => {
    // Clearing `note` must not sweep `notes`. The trailing colon on the namespace is
    // what makes the boundary unambiguous, and dropping it looks like a simplification.
    useStorage('note').setItem('x', 'short');
    useStorage('notes').setItem('x', 'long');

    clearAppStorage('note');

    expect(useStorage('notes').getItem<string>('x')).toBe('long');

    clearAppStorage('notes');
  });
});
