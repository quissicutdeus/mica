import { describe, expect, it, afterEach } from 'vitest';
import { get } from 'svelte/store';
import { useKeybinds } from './useKeybinds';
import { appRegistryStore } from '../../shell/state/registry';

describe('useKeybinds groups', () => {
  const fakeManifest = {
    id: 'snek_hook_test',
    name: 'Snek Hook Test',
    color: 'bg-green-600',
    icon: null,
    core: false,
    keybinds: [{ id: 'pause', label: 'Pause Game', defaultKey: 'p' }]
  } as const;

  afterEach(() => {
    try {
      appRegistryStore.unregisterApp(fakeManifest.id);
    } catch {
      // not registered
    }
  });

  it('puts core actions in a "Phone" group first, then one group per app, alphabetical', () => {
    appRegistryStore.registerApp(fakeManifest as any, (() => {}) as any);
    const { groups } = useKeybinds();
    const value = get(groups);

    expect(value[0].ownerId).toBe('core');
    expect(value[0].ownerLabel).toBe('Phone');

    const appGroup = value.find((g) => g.ownerId === 'snek_hook_test');
    expect(appGroup?.ownerLabel).toBe('Snek Hook Test');
    expect(appGroup?.actions).toEqual([
      expect.objectContaining({ id: 'snek_hook_test:pause', label: 'Pause Game' })
    ]);

    // Alphabetical among app groups (there's only one here, but the sort itself is
    // exercised by the next test).
  });

  it('sorts app groups alphabetically by ownerLabel after the core group', () => {
    appRegistryStore.registerApp(
      { ...fakeManifest, id: 'zzz_app', name: 'ZZZ App' } as any,
      (() => {}) as any
    );
    appRegistryStore.registerApp(
      { ...fakeManifest, id: 'aaa_app', name: 'AAA App' } as any,
      (() => {}) as any
    );

    const { groups } = useKeybinds();
    const ids = get(groups).map((g) => g.ownerId);
    const aaaIndex = ids.indexOf('aaa_app');
    const zzzIndex = ids.indexOf('zzz_app');
    expect(aaaIndex).toBeGreaterThan(0); // after core
    expect(aaaIndex).toBeLessThan(zzzIndex);

    appRegistryStore.unregisterApp('zzz_app');
    appRegistryStore.unregisterApp('aaa_app');
  });

  it('omits an app entirely from groups when it declares no keybinds', () => {
    appRegistryStore.registerApp(
      { id: 'no_binds_app', name: 'No Binds', color: 'bg-gray-600', icon: null, core: false } as any,
      (() => {}) as any
    );
    const { groups } = useKeybinds();
    expect(get(groups).some((g) => g.ownerId === 'no_binds_app')).toBe(false);
    appRegistryStore.unregisterApp('no_binds_app');
  });

  it('findConflict resolves an app-declared action id, not just core ones', () => {
    appRegistryStore.registerApp(fakeManifest as any, (() => {}) as any);
    const { findConflict } = useKeybinds();

    // 'p' isn't used by anything else yet, so no conflict...
    expect(findConflict('snek_hook_test:pause', 'p')).toBeUndefined();

    // ...but 'back' defaults to Backspace, and rebinding the app action onto Backspace
    // must be caught even though 'back' is a core action, not an app-declared one.
    const conflict = findConflict('snek_hook_test:pause', 'Backspace');
    expect(conflict?.id).toBe('back');
  });
});
