// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
// In-process facets: a unit test stands in for the shell (`store.test.ts` says why).
import '../../host/registerFacets';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { useAppRegistry, useAppRegistryWrite, type AppManifest } from '@mica/sdk';
import { renderApp } from '@mica/sdk/testing';
import { GENERIC_SERVICE_ACTION } from '@mica/shared/rpc';
import manifest from './manifest';
import { catalogApps, deviceUnavailableReason } from './appInfo';
import StoreTablet from './tablet.svelte';
import { setActiveDevice } from '../../shell/state/device';
import { manifestSupportsDevice } from '../../lib/phone/appVisibility';
import { appRegistryStore } from '../../shell/state/registry';
import { flushPendingWrites } from '../../host/settingsSync';
import { hydrateSettingsOnCharacterLoad } from '../../host/facets/storage';
import { fetchNui } from '../../nui/fetchNui';

// Every capability present, as in `store.test.ts`, so only the device decides here.
vi.mock('@mica/sdk/core', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useCapabilities: () => {
    const answer = { known: true, missing: () => [] };
    return { ...answer, subscribe: (run: (v: typeof answer) => void) => (run(answer), () => {}) };
  }
}));

// jsdom has no Web Animations API, and the Store's dialogs transition (`store.test.ts`).
if (!Element.prototype.animate) {
  Element.prototype.animate = vi.fn().mockReturnValue({
    cancel: () => {},
    finish: () => {},
    effect: { getComputedTiming: () => ({ duration: 0 }) }
  });
}

const { registryStore } = useAppRegistry();
const { registerAddOn, unregisterApp } = useAppRegistryWrite();

const addOn = (id: string): AppManifest => {
  const found = catalogApps().find((a) => a.id === id);
  if (!found) throw new Error(`no bundled add-on '${id}' in this build`);
  return found;
};
const installed = (id: string) => get(registryStore).some((a) => a.id === id);

/**
 * What the device's own `settings:getAll` holds for the install list, asked through the real
 * browser mock — which keeps every settings row per device (MICA-264) — exactly as the
 * hydrate below asks it.
 */
const serverInstallList = async (device: 'phone' | 'tablet'): Promise<string | undefined> => {
  const rows = await fetchNui<{ app: string; setting_key: string; setting_value: string }[]>(
    GENERIC_SERVICE_ACTION,
    { service: 'settings', action: 'getAll', device }
  );
  return rows.find((r) => r.app === 'store' && r.setting_key === 'installedAddOns')?.setting_value;
};

afterEach(() => {
  setActiveDevice('phone');
  for (const id of ['notes', 'snek']) {
    if (installed(id)) unregisterApp(id);
  }
  flushPendingWrites();
});

/** MICA-264: the Store is on the tablet, and a tablet keeps installs of its own. */
describe('the Store on the tablet', () => {
  it('is on the tablet, with a tablet root of its own', async () => {
    expect(manifest.devices).toEqual(['phone', 'tablet']);
    expect(manifestSupportsDevice(manifest, 'tablet')).toBe(true);
    // The registry's `tablet.svelte` glob finds this root, so the tablet opens it, not the
    // phone's `index.svelte`.
    expect(await appRegistryStore.loadComponent('store', 'tablet')).toBe(StoreTablet);
  });

  it('renders the list beside an empty detail pane, and shows a selected app there', async () => {
    setActiveDevice('tablet');
    const { getByRole, getByTestId, getAllByText, findByText } = renderApp(StoreTablet, {
      id: 'store'
    });

    expect(getByRole('group', { name: 'Store sections' })).toBeTruthy();
    const detail = getByTestId('store-detail');
    expect(detail.textContent).toContain('Select an app');

    (await findByText('Notes')).click();
    await vi.waitFor(() => expect(detail.textContent).toContain('Notes'));
    expect(getAllByText('Install Application').length).toBeGreaterThan(0);
  });

  it('installs into the tablet, and the phone does not have it', async () => {
    setActiveDevice('tablet');
    registerAddOn(addOn('notes'));
    expect(installed('notes')).toBe(true);
    // The debounced write goes out now, stamped with the tablet it was made on.
    flushPendingWrites();
    await vi.waitFor(async () => expect(await serverInstallList('tablet')).toContain('notes'));
    expect(await serverInstallList('phone')).toBeUndefined();

    // Over to the phone: its own rows are read, and the tablet's install is not among them.
    setActiveDevice('phone');
    await hydrateSettingsOnCharacterLoad();
    expect(installed('notes')).toBe(false);

    // And back: the tablet's list brings it back, storage and grant untouched.
    setActiveDevice('tablet');
    await hydrateSettingsOnCharacterLoad();
    expect(installed('notes')).toBe(true);
  });

  it('refuses a phone-only add-on on the tablet, and shows it unavailable there', () => {
    const snek = addOn('snek');
    expect(snek.devices).toBeUndefined();

    setActiveDevice('tablet');
    expect(() => registerAddOn(snek)).toThrow('is not available on this device.');
    expect(installed('snek')).toBe(false);
    expect(deviceUnavailableReason(snek.devices, 'tablet', (key) => key)).toBe(
      'store.notOnThisDevice'
    );

    // The same add-on installs on the phone, which is the device it is for.
    setActiveDevice('phone');
    expect(deviceUnavailableReason(snek.devices, 'phone', (key) => key)).toBeNull();
    registerAddOn(snek);
    expect(installed('snek')).toBe(true);
  });
});
