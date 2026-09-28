// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { DEFAULT_DEVICE, isDeviceId, type DeviceId } from '@mica/shared/devices';
import { s } from '@mica/shared/schema';
import { guardNetEvent } from './netGuard';

/**
 * Whether a player's phone is open right now, mirrored from the client.
 *
 * There is no way to ask a client synchronously — `SetNuiFocus`, the animation state and
 * `PhoneState.isOpen()` all live only on their machine, and this codebase has no
 * server-initiated round trip to ask and wait (see `shared/rpc.ts`, which is NUI-to-server
 * only). So this is fed the same way Signal and Battery are: a fire-and-forget push
 * whenever the client's own state changes, cached here, and `IsPhoneOpen` answers from
 * the last value pushed rather than asking fresh.
 *
 * That makes it eventually-consistent rather than live — a push in flight when a caller
 * asks reads one state behind for a moment — which is the same trade-off `describeSignalFor`
 * already makes and the right one here too.
 */
const open = new Map<string, boolean>();

/** One entry per device per source (MICA-263): the tablet being up says nothing about the phone. */
const keyOf = (source: number, device: DeviceId): string => `${source}:${device}`;

/** Whether this device is open. Defaults to closed for a source, or a device, never heard from. */
export const isDeviceOpen = (source: number, device: DeviceId): boolean =>
  open.get(keyOf(source, device)) ?? false;

/** Test seam: the map is module state that would otherwise leak between cases. */
export const __resetOpenState = (): void => {
  open.clear();
};

/**
 * The client pushes `{ device, open }` since MICA-262 and pushed a bare boolean before it,
 * which still means the phone, as does an object with no `device`. A `device` that is not
 * one of `shared/devices.ts`'s is dropped rather than read as the phone: a client naming a
 * device this server does not know is not describing the phone, and recording it there
 * would let one frame answer for another.
 */
const SET_OPEN_INPUT = s.tuple([
  s.union([
    s.boolean(),
    s.object({ device: s.string({ max: 32 }).optional(), open: s.boolean().optional() })
  ])
]);

onNet('mica:server:shell:setOpen', (...args: unknown[]) => {
  const src = source;
  const guarded = guardNetEvent('shell', 'setOpen', SET_OPEN_INPUT, args);
  if (!guarded) return;
  const [payload] = guarded.input;
  if (typeof payload === 'boolean') {
    open.set(keyOf(src, DEFAULT_DEVICE), payload);
    return;
  }
  const device = payload.device === undefined ? DEFAULT_DEVICE : payload.device;
  if (!isDeviceId(device)) return;
  open.set(keyOf(src, device), payload.open === true);
});

on('playerDropped', () => {
  // FiveM reuses server ids, so a stale `true` left behind would tell the next player's
  // caller their device is open before they have ever pressed a key. Every device's.
  const prefix = `${source}:`;
  for (const key of open.keys()) if (key.startsWith(prefix)) open.delete(key);
});
