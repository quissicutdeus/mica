// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DeviceId } from '@mica/shared/devices';
import type { FrameworkPlayer } from './framework/runtime';

/**
 * Which device a request, or a citizen, is on — asked here, answered in `services/Devices.ts`
 * (MICA-282). A request names the device it speaks for (MICA-264), and a tablet's rows are
 * keyed on its own id the same way. `phoneForCitizen` keeps its name because it only ever
 * answers a phone.
 *
 * `ServiceEndpoint` has to know the caller's phone to scope a device-owned action, and it
 * cannot import the service that knows: `defineService` imports `ServiceEndpoint`, and
 * `services/Devices.ts` is a `defineService` call, so the reverse edge is a runtime cycle.
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

/**
 * What a request already knows, handed to the resolver so it is not asked twice (MICA-362).
 *
 * **Per call, never remembered.** Nothing here outlives the request that passed it: the slot
 * read behind `requireHeld` is the phone-in-hand proof, and a phone taken in a robbery a second
 * ago must be refused on the next request, not answered from the last one.
 */
export interface RequestDeviceOptions {
  /**
   * The player `ServiceEndpoint` looked up for this request, so the resolver does not walk the
   * framework's player table for the same source again. Absent, it looks them up itself.
   *
   * Only ever the player looked up for this same request, with no host event able to run in
   * between — a character switch keeps the source (`forgetOnPlayerLoaded`), so a player held
   * across a yield to the host would name the previous character's inventory.
   */
  player?: FrameworkPlayer;
  /**
   * Refuse a player holding none of the device, as `requireDeviceInHand` does, answered from
   * the one slot read the resolve makes anyway rather than a count beside it. Also refuses a
   * device this server has off. Where the inventory cannot list slots at all (es_extended's own
   * inventory), the resolver counts instead, so the check is never weaker than the count.
   */
  requireHeld?: boolean;
}

export type RequestDeviceResolver = (
  src: number,
  citizenid: string,
  device?: DeviceId,
  options?: RequestDeviceOptions
) => Promise<string>;
export type CitizenPhoneResolver = (citizenid: string) => Promise<string>;
/** Throws a `PlayerFacingError` when the device is off or the player holds none of it. */
export type DeviceInHandCheck = (player: FrameworkPlayer, device: DeviceId) => void;
/** `DeviceInHandCheck`, reading what it has to first (MICA-436 review). Rejects the same way. */
export type DeviceInHandRead = (player: FrameworkPlayer, device: DeviceId) => Promise<void>;

let forRequest: RequestDeviceResolver | null = null;
let forCitizen: CitizenPhoneResolver | null = null;
let deviceInHand: DeviceInHandCheck | null = null;
let deviceInHandRead: DeviceInHandRead | null = null;

/** Called once, by `services/Devices.ts`, at import. */
export const installDeviceResolvers = (resolvers: {
  forRequest: RequestDeviceResolver;
  forCitizen: CitizenPhoneResolver;
  deviceInHand: DeviceInHandCheck;
  deviceInHandRead: DeviceInHandRead;
}): void => {
  forRequest = resolvers.forRequest;
  forCitizen = resolvers.forCitizen;
  deviceInHand = resolvers.deviceInHand;
  deviceInHandRead = resolvers.deviceInHandRead;
};

/**
 * Test seam. Pass nothing to clear every slot. A suite that installs only `deviceInHand` gets
 * a `deviceInHandRead` that asks it, so a stub answers both questions the same way.
 */
export const __setDeviceResolvers = (resolvers?: {
  forRequest?: RequestDeviceResolver;
  forCitizen?: CitizenPhoneResolver;
  deviceInHand?: DeviceInHandCheck;
  deviceInHandRead?: DeviceInHandRead;
}): void => {
  forRequest = resolvers?.forRequest ?? null;
  forCitizen = resolvers?.forCitizen ?? null;
  const check = resolvers?.deviceInHand ?? null;
  deviceInHand = check;
  deviceInHandRead =
    resolvers?.deviceInHandRead ??
    (check ? async (player: FrameworkPlayer, device: DeviceId) => check(player, device) : null);
};

const notInstalled = (what: string): Error =>
  new Error(
    `[mica] ${what} was asked for before services/Devices.ts installed its resolver. A ` +
      `device-owned action cannot run without knowing which device it is for; import the ` +
      `services barrel, or install a resolver in the test.`
  );

/**
 * The device the caller of a request is on — the phone unless `device` names another.
 *
 * Throws a `PlayerFacingError` (from the resolver) for a player holding none of that device on
 * a server that gates on it — there is no device for their rows to belong to, and it is closed
 * for them anyway — and degrades to the citizen's identity device of that kind where no item
 * can carry an id at all. `services/Devices.ts` has the three cases. With `requireHeld` it is also
 * the in-hand check (`RequestDeviceOptions`), so a request that needs both pays one slot read.
 */
export const deviceForRequest = (
  src: number,
  citizenid: string,
  device: DeviceId = 'phone',
  options?: RequestDeviceOptions
): Promise<string> => {
  if (!forRequest) throw notInstalled('the device for a request');
  return forRequest(src, citizenid, device, options);
};

/**
 * Refuse a player from a device this server has off, or that they hold none of their own of
 * (MICA-264, MICA-436), **synchronously**: a slot carrying an id whose row this process has not
 * read yet counts as held, because nothing synchronous can read it. For a caller that cannot
 * yield — the call-answer path in `Phone.ts`, whose ordering keeps two answers from both
 * winning a group call. A request goes through `requireDeviceInHandRead` instead.
 */
export const requireDeviceInHand = (player: FrameworkPlayer, device: DeviceId): void => {
  if (!deviceInHand) throw notInstalled('the device check for a request');
  deviceInHand(player, device);
};

/**
 * Refuse a request from a device this server has off, or that the player holds none of their
 * own of (MICA-264, MICA-436 review), reading every unseen slot's row first. `ServiceEndpoint`
 * asks it for every request that names a device other than the phone and every phone action
 * flagged `requirePhoneFor`, so a holder of nothing but somebody else's phone is refused on the
 * first request. An unfilled slot throws, so a request with no resolver installed is refused.
 */
export const requireDeviceInHandRead = async (
  player: FrameworkPlayer,
  device: DeviceId
): Promise<void> => {
  if (!deviceInHandRead) throw notInstalled('the device check for a request');
  await deviceInHandRead(player, device);
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
