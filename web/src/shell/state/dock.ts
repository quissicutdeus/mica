// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { derived, get } from 'svelte/store';
import { DEVICES, type DeviceDescriptor, type DeviceId } from '@mica/shared/devices';
import { activeDevice, descriptor, perDevice, persistedKeyFor } from './device';
import { ownerConfig } from './ownerConfig';
import { storage } from '../../host/facets/storage';

/** The active device's slot count — 4 on the phone, 6 on the tablet (MICA-259). */
export const dockSlotCount = derived(descriptor, ($d) => $d.launcher.dockSlots);

/** Phone, Messages, Media, Camera — the ids are directory names under `web/src/apps/`. */
export const DEFAULT_DOCK_APP_IDS = ['phone', 'messages', 'media', 'camera'];

/**
 * What a fresh dock holds, per device. The phone's is the list above, unchanged. The
 * tablet's is Admin and Settings — two of the three apps MICA-252 named as its first,
 * and the two that are `core: true`. Notes is a Store add-on, and core may not name one
 * (`sdk/coreBoundary.test.ts`); it reaches the tablet's dock the way it reaches the
 * phone's, by being dragged there. `Dock.svelte` draws a placeholder for an empty entry
 * and for an id the player cannot see (Admin, for anyone who is not one), so the row
 * keeps its shape either way.
 */
const DEFAULT_DOCK_APP_IDS_BY_DEVICE: Readonly<Record<DeviceId, readonly string[]>> = {
  phone: DEFAULT_DOCK_APP_IDS,
  tablet: ['admin', 'settings']
};

/**
 * Exactly `dockSlots` entries, positionally significant — index *is* the slot. An empty
 * string marks an unconfigured slot rather than shrinking the array, so slot 2 stays slot 2
 * even if slot 0 and 1 are unset; `Dock.svelte` renders a placeholder for an empty entry.
 *
 * Does *not* filter a non-empty id against the app registry's known ids: the registry's
 * add-on half rehydrates asynchronously (`registry.ts`'s `installedAddOnIds` subscription),
 * so a sanitizer that ran before that finished would permanently strip a valid dock id it
 * hadn't learned about yet. `Dock.svelte` skips rendering a slot whose id resolves to no
 * manifest instead — the same tolerance `Shell.svelte` already gives an app whose component
 * hasn't loaded.
 *
 * The device defaults to the phone so a caller with none in hand sanitises the way it
 * always has; the per-device store below passes its own.
 */
export function sanitizeDockAppIds(
  value: unknown,
  device: DeviceDescriptor = DEVICES.phone
): string[] {
  const count = device.launcher.dockSlots;
  if (!Array.isArray(value)) return defaultDockFor(device);
  const strings = value.filter((v): v is string => typeof v === 'string');
  const seen = new Set<string>();
  const deduped = strings.map((id) => {
    if (id === '' || seen.has(id)) return '';
    seen.add(id);
    return id;
  });
  const slots = deduped.slice(0, count);
  while (slots.length < count) slots.push('');
  return slots;
}

const defaultDockFor = (device: DeviceDescriptor): string[] => {
  const slots = [...DEFAULT_DOCK_APP_IDS_BY_DEVICE[device.id]];
  while (slots.length < device.launcher.dockSlots) slots.push('');
  return slots;
};

/** One dock per device, following `activeDevice` — see `perDevice`. */
export const dockAppIds = perDevice<string[]>('dockAppIds', defaultDockFor, sanitizeDockAppIds);

/** Replaces one slot outright — used when an app is dragged onto the dock. */
export function setDockSlot(index: number, appId: string): void {
  const device = DEVICES[get(activeDevice)];
  if (index < 0 || index >= device.launcher.dockSlots) return;
  dockAppIds.update((current) => {
    const next = sanitizeDockAppIds(current, device);
    // The app may already occupy another slot; dragging it onto a new one moves it rather
    // than duplicating it across two slots.
    const previousIndex = next.indexOf(appId);
    if (previousIndex !== -1) next[previousIndex] = '';
    next[index] = appId;
    return next;
  });
}

const settingsStorage = storage('settings');

/**
 * Whether the phone's dock has ever actually been written to storage — distinct from
 * `dockAppIds` merely *holding* the built-in default, which is equally true of a fresh
 * install nobody has touched. `usePersisted` deliberately writes nothing at construction
 * (see its own doc), so an unset key is the honest signal of "nobody has an opinion yet";
 * reading the raw stored value (rather than trusting `dockAppIds`'s current in-memory
 * value) is what tells "never saved" apart from "saved, and happens to equal the default".
 */
const hasStoredPhoneDock = (): boolean =>
  settingsStorage.getItem<string[]>(persistedKeyFor('dockAppIds', 'phone')) !== null;

/**
 * MICA-234: an owner's `mica_default_dock` replaces the phone's built-in default dock —
 * never the tablet's, which the convar does not configure (`shared/ownerConfig.ts`) — and
 * only for a player who has not touched (or been given) a dock of their own.
 *
 * The config answer arrives asynchronously, strictly after `perDevice` has already
 * constructed the phone's dock store with the built-in default as its starting value — see
 * `hasStoredPhoneDock`'s own doc for why that starting value is not itself evidence of a
 * save. Writing straight to `dockAppIds.forDevice('phone')` rather than through the
 * `activeDevice`-following `dockAppIds` proxy is deliberate too: the config can answer while
 * the tablet is the device on screen, and this must land on the phone's slot regardless.
 */
ownerConfig.subscribe(($config) => {
  if ($config.defaultDock.length === 0) return;
  if (hasStoredPhoneDock()) return;
  dockAppIds.forDevice('phone').set(sanitizeDockAppIds($config.defaultDock, DEVICES.phone));
});
