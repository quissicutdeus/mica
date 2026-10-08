// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DeviceId } from '@mica/shared/devices';
import type { FrameworkPlayer } from './framework/runtime';

/**
 * Which phone a request, or a citizen, is on — asked here, answered in `services/Phones.ts`
 * (MICA-282). Since MICA-264 "phone" here means any device with an identity — a request names
 * the device it speaks for, and a tablet's rows are keyed on its own id the same way — but the
 * names stay, to keep the churn out of every caller that only ever meant the phone.
 *
 * `ServiceEndpoint` has to know the caller's phone to scope a device-owned action, and it
 * cannot import the service that knows: `defineService` imports `ServiceEndpoint`, and
 * `services/Phones.ts` is a `defineService` call, so the reverse edge is a runtime cycle.
 * This module is the seam between them — two function slots the service fills at import,
 * the same shape `lib/services.ts` uses for the registry the endpoint registers into. The third
 * slot, `deviceInHand`, is here for the same cycle: the item count lives in `deviceItem.ts`,
 * which reaches `ServiceEndpoint` back through `shell.ts`.
 *
 * **An unfilled slot throws rather than answering.** A device-owned action that ran before
 * the resolver was installed — a test that imported one service without the barrel, a boot
 * order nobody intended — would otherwise have to guess a phone, and every guess is a way
 * for a row to land on the wrong device. The throw is a server-side `Error`, so the player
 * sees the generic message and the log names this file.
 */

export type RequestPhoneResolver = (
  src: number,
  citizenid: string,
  device?: DeviceId
) => Promise<string>;
export type CitizenPhoneResolver = (citizenid: string) => Promise<string>;
/** Throws a `PlayerFacingError` when the device is off or the player holds none of it. */
export type DeviceInHandCheck = (player: FrameworkPlayer, device: DeviceId) => void;

let forRequest: RequestPhoneResolver | null = null;
let forCitizen: CitizenPhoneResolver | null = null;
let deviceInHand: DeviceInHandCheck | null = null;

/** Called once, by `services/Phones.ts`, at import. */
export const installPhoneResolvers = (resolvers: {
  forRequest: RequestPhoneResolver;
  forCitizen: CitizenPhoneResolver;
  deviceInHand: DeviceInHandCheck;
}): void => {
  forRequest = resolvers.forRequest;
  forCitizen = resolvers.forCitizen;
  deviceInHand = resolvers.deviceInHand;
};

/** Test seam. Pass nothing to clear every slot. */
export const __setPhoneResolvers = (resolvers?: {
  forRequest?: RequestPhoneResolver;
  forCitizen?: CitizenPhoneResolver;
  deviceInHand?: DeviceInHandCheck;
}): void => {
  forRequest = resolvers?.forRequest ?? null;
  forCitizen = resolvers?.forCitizen ?? null;
  deviceInHand = resolvers?.deviceInHand ?? null;
};

const notInstalled = (what: string): Error =>
  new Error(
    `[mica] ${what} was asked for before services/Phones.ts installed its resolver. A ` +
      `device-owned action cannot run without knowing which phone it is for; import the ` +
      `services barrel, or install a resolver in the test.`
  );

/**
 * The device the caller of a request is on — the phone unless `device` names another.
 *
 * Throws a `PlayerFacingError` (from the resolver) for a player holding none of that device on
 * a server that gates on it — there is no device for their rows to belong to, and it is closed
 * for them anyway — and degrades to the citizen's identity device of that kind where no item
 * can carry an id at all. `services/Phones.ts` has the three cases.
 */
export const phoneForRequest = (
  src: number,
  citizenid: string,
  device: DeviceId = 'phone'
): Promise<string> => {
  if (!forRequest) throw notInstalled('the phone for a request');
  return forRequest(src, citizenid, device);
};

/**
 * Refuse a request from a device this server has off, or that the player holds none of
 * (MICA-264). `ServiceEndpoint` asks it for every request that names a device other than the
 * phone; an unfilled slot throws, so a tablet request with no resolver installed is refused.
 */
export const requireDeviceInHand = (player: FrameworkPlayer, device: DeviceId): void => {
  if (!deviceInHand) throw notInstalled('the device check for a request');
  deviceInHand(player, device);
};

/**
 * The phone a citizen is on, for a row written on their behalf — a notification, a photo
 * dropped onto them, a contact a job hands them. Their active phone when this process has
 * seen one, else the phone they used most recently, else their identity phone, created if
 * they have none.
 */
export const phoneForCitizen = (citizenid: string): Promise<string> => {
  if (!forCitizen) throw notInstalled('the phone for a citizen');
  return forCitizen(citizenid);
};
