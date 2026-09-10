// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { derived, get } from 'svelte/store';
import { DEVICES, type DeviceDescriptor, type DeviceId } from '@mica/shared/devices';
import {
  activeDevice,
  descriptor,
  perDevice,
  persistedKeyFor,
  type PerDeviceStore
} from './device';
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

/**
 * One dock per device, following `activeDevice` — see `perDevice`. Internal: every other
 * module reads and writes through `dockAppIds` below, which overlays the owner's default
 * onto this one rather than ever writing it in.
 */
const savedDockAppIds = perDevice<string[]>('dockAppIds', defaultDockFor, sanitizeDockAppIds);

const settingsStorage = storage('settings');

/**
 * Whether the phone's dock has ever actually been written to storage — distinct from
 * `savedDockAppIds` merely *holding* the built-in default, which is equally true of a fresh
 * install nobody has touched. `usePersisted` deliberately writes nothing at construction
 * (see its own doc), so an unset key is the honest signal of "nobody has an opinion yet";
 * reading the raw stored value (rather than trusting the in-memory value) is what tells
 * "never saved" apart from "saved, and happens to equal the default".
 */
const hasStoredPhoneDock = (): boolean =>
  settingsStorage.getItem<string[]>(persistedKeyFor('dockAppIds', 'phone')) !== null;

/**
 * MICA-234: an owner's `mica_default_dock` overlaid onto the phone's saved one — never the
 * tablet's, which the convar does not configure (`shared/ownerConfig.ts`) — for as long as
 * nobody has touched (or been given) a dock of their own.
 *
 * A `derived` that recomputes on every change of either input, rather than the one-shot
 * write `ownerConfig.subscribe` used to make straight into `savedDockAppIds.forDevice('phone')`.
 * That write was the bug: `usePersisted`'s outer `set` both writes the key *and* queues a
 * debounced save to the server (`storage.ts`'s `queueWrite`, 400ms), so whichever of
 * `shell:ownerConfig` and the settings rehydrate answered first decided the outcome —
 * `ownerConfig` first meant the owner's default got written as if the player had chosen it,
 * and the queued save could then land *after* the rehydrate and overwrite the player's real
 * saved dock on the server with it. A character switch made it worse: the dock the previous
 * character saved is still sitting in the shared local cache until this character's own
 * rehydrate lands, so `hasStoredPhoneDock` could see a key that was never this character's.
 *
 * Recomputing instead of writing means the owner default is applied fresh every time,
 * never persisted on its own, and a rehydrated server value — which lands through
 * `savedDockAppIds` the same way any other write does — always wins simply by making
 * `hasStoredPhoneDock` true. Order between the two answers stops mattering.
 */
const dockOverlay = derived(
  [savedDockAppIds, ownerConfig, activeDevice],
  ([$saved, $owner, $device]): string[] =>
    $device === 'phone' && $owner.defaultDock.length > 0 && !hasStoredPhoneDock()
      ? sanitizeDockAppIds($owner.defaultDock, DEVICES.phone)
      : $saved
);

/** What every other module reads and writes — see `dockOverlay`'s doc for the read half. */
export const dockAppIds: PerDeviceStore<string[]> = {
  subscribe: dockOverlay.subscribe,
  set: savedDockAppIds.set,
  update: savedDockAppIds.update,
  forDevice: savedDockAppIds.forDevice
};

/** Replaces one slot outright — used when an app is dragged onto the dock. */
export function setDockSlot(index: number, appId: string): void {
  const device = DEVICES[get(activeDevice)];
  if (index < 0 || index >= device.launcher.dockSlots) return;
  // Built from what is actually on screen, owner default included — a drag the player can
  // see has to move the app relative to that, not to a saved value that may not be showing.
  const next = sanitizeDockAppIds(get(dockAppIds), device);
  // The app may already occupy another slot; dragging it onto a new one moves it rather
  // than duplicating it across two slots.
  const previousIndex = next.indexOf(appId);
  if (previousIndex !== -1) next[previousIndex] = '';
  next[index] = appId;
  savedDockAppIds.set(next);
}
