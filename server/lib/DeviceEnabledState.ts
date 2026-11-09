// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DeviceId } from '@mica/shared/devices';

/**
 * Which devices the server's `SetPhoneEnabled` export last confiscated, per source (MICA-474).
 *
 * The export used to push the client's flag and keep nothing, so the server rang a phone that a
 * jail script had just taken: the client would not raise it (MICA-467), and the caller heard it
 * ring until they gave up. `Phone.ts` asks this before it rings anyone, and before it lets
 * anyone answer.
 *
 * **What the server said, not what the client holds.** The client keeps one flag that both this
 * export's push and the client-side `SetPhoneEnabled` export write (`client/lib/DeviceState.ts`).
 * The second never reaches the server, so a phone confiscated only from the client side is not
 * known here.
 *
 * **Per source, cleared on drop, kept across a character switch.** The client's flag is per
 * connection and survives a switch, so this does too: the two must agree, and a server that
 * forgot a confiscation the client still enforces would ring a phone that will not come up.
 * FiveM reuses server ids, so a drop forgets the source.
 *
 * In-memory, like `PhoneOpenState.ts` and `LockState.ts`. A restart clears it, as it clears the
 * client's flag; a resource that confiscates has to reapply it after one, as it always had to.
 *
 * Imports nothing at runtime: `publicApi.ts` writes it and `services/Phone.ts` reads it, and
 * `publicApi.ts` imports `Phone.ts`, so anything this imported could close a cycle.
 */
const confiscated = new Set<string>();

const keyOf = (source: number, device: DeviceId): string => `${source}:${device}`;

/** Whether the server last told this source's device to stay shut. Never heard from: no. */
export const isDeviceConfiscated = (source: number, device: DeviceId): boolean =>
  confiscated.has(keyOf(source, device));

/** For `SetPhoneEnabled` alone. Not net-reachable: only another resource's export call sets it. */
export const recordDeviceEnabled = (source: number, device: DeviceId, enabled: boolean): void => {
  if (enabled) confiscated.delete(keyOf(source, device));
  else confiscated.add(keyOf(source, device));
};

/** Test seam: the set is module state that would otherwise leak between cases. */
export const __resetDeviceEnabledState = (): void => {
  confiscated.clear();
};

on('playerDropped', () => {
  const prefix = `${source}:`;
  for (const key of confiscated) if (key.startsWith(prefix)) confiscated.delete(key);
});
