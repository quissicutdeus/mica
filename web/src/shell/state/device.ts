// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { derived, get, writable, type Writable } from 'svelte/store';
import {
  ALL_DEVICES,
  DEFAULT_DEVICE,
  DEVICES,
  type DeviceDescriptor,
  type DeviceId
} from '@gos/shared/devices';
import { usePersisted, type PersistedOptions } from '../../../../sdk/host/usePersisted';

/**
 * Which device the shell is being right now (MICA-259, the second slice of MICA-252).
 *
 * The shell used to *be* the phone: its size was two constants, its chrome one component,
 * its launcher one grid. Now it is one frame drawn from a descriptor, and this store says
 * which descriptor. Everything downstream — the frame's size and zoom, the sheets' travel,
 * the launcher's grid, the dock's slot count, which navigation snapshot is live — derives
 * from it, so switching device is one `set` rather than a tour of the shell.
 *
 * Distinct from `phoneOpen.ts`'s `openDevice`, which says whether a frame is *on screen*.
 * A closed shell still has an active device: the browser's reopen button raises
 * whichever this names, and the tablet's persisted home grid has to be the one that loads
 * when `?device=tablet` boots the page closed and the first open follows.
 *
 * `'phone'` until something says otherwise — in game the client's `setVisible` carries the
 * device (a bare boolean means the phone, `shared/nui.ts`); in a browser the `?device=`
 * query on `Shell.svelte`'s boot and the device keybinds do.
 */
export const activeDevice = writable<DeviceId>(DEFAULT_DEVICE);

export const setActiveDevice = (id: DeviceId): void => {
  if (get(activeDevice) !== id) activeDevice.set(id);
};

/** The active device's table row: frame, bezel, launcher, chrome. */
export const descriptor = derived(activeDevice, ($id): DeviceDescriptor => DEVICES[$id]);

/** The design size every screen is laid out against, before `display.ts`'s zoom. */
export const frame = derived(descriptor, ($d) => $d.frame);

/**
 * A persisted setting with one value per device, presented as a single store that
 * follows `activeDevice`.
 *
 * The launcher's grid, the dock and the home grid's items are each a `usePersisted` read
 * once at construction under one key, and a second device cannot share the value — a
 * 6-slot tablet dock sanitised down to the phone's 4 would drop two pins every boot. So
 * there is one persisted store per device, and the shell talks to whichever is active
 * through this proxy. Reads switch with the device; a write lands in the active device's
 * own key.
 *
 * **The phone's key is unchanged**, deliberately: `homeGridItems` stays `homeGridItems`,
 * so every existing save and every e2e seed (`support/homeGrid.ts`) still means the phone.
 * Only a second device takes a suffix — `homeGridItems:tablet` — which also keeps the
 * `settings` namespace flat enough that `hydrateSettings` can carry it as one row.
 */
export const perDevice = <T>(
  key: string,
  initial: (device: DeviceDescriptor) => T,
  sanitize: (value: unknown, device: DeviceDescriptor) => T
): Writable<T> => {
  const stores = Object.fromEntries(
    ALL_DEVICES.map((id) => {
      const device = DEVICES[id];
      const options: PersistedOptions<T> = { sanitize: (value) => sanitize(value, device) };
      return [id, usePersisted<T>('settings', persistedKeyFor(key, id), initial(device), options)];
    })
  ) as Record<DeviceId, Writable<T>>;

  const current = () => stores[get(activeDevice)];
  const value = derived(
    [activeDevice, ...ALL_DEVICES.map((id) => stores[id])],
    ([$id, ...$values]) => $values[ALL_DEVICES.indexOf($id)]
  );

  return {
    subscribe: value.subscribe,
    set: (next) => current().set(next),
    update: (fn) => current().update(fn)
  };
};

/** `homeGridItems` for the phone, `homeGridItems:tablet` for the tablet — see `perDevice`. */
export const persistedKeyFor = (key: string, device: DeviceId): string =>
  device === DEFAULT_DEVICE ? key : `${key}:${device}`;
