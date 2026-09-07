// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Which phone a request, or a citizen, is on — asked here, answered in `services/Phones.ts`
 * (MICA-282).
 *
 * `ServiceEndpoint` has to know the caller's phone to scope a device-owned action, and it
 * cannot import the service that knows: `defineService` imports `ServiceEndpoint`, and
 * `services/Phones.ts` is a `defineService` call, so the reverse edge is a runtime cycle.
 * This module is the seam between them — two function slots the service fills at import,
 * the same shape `lib/services.ts` uses for the registry the endpoint registers into.
 *
 * **An unfilled slot throws rather than answering.** A device-owned action that ran before
 * the resolver was installed — a test that imported one service without the barrel, a boot
 * order nobody intended — would otherwise have to guess a phone, and every guess is a way
 * for a row to land on the wrong device. The throw is a server-side `Error`, so the player
 * sees the generic message and the log names this file.
 */

export type RequestPhoneResolver = (src: number, citizenid: string) => Promise<string>;
export type CitizenPhoneResolver = (citizenid: string) => Promise<string>;

let forRequest: RequestPhoneResolver | null = null;
let forCitizen: CitizenPhoneResolver | null = null;

/** Called once, by `services/Phones.ts`, at import. */
export const installPhoneResolvers = (resolvers: {
  forRequest: RequestPhoneResolver;
  forCitizen: CitizenPhoneResolver;
}): void => {
  forRequest = resolvers.forRequest;
  forCitizen = resolvers.forCitizen;
};

/** Test seam. Pass nothing to clear both slots. */
export const __setPhoneResolvers = (resolvers?: {
  forRequest?: RequestPhoneResolver;
  forCitizen?: CitizenPhoneResolver;
}): void => {
  forRequest = resolvers?.forRequest ?? null;
  forCitizen = resolvers?.forCitizen ?? null;
};

const notInstalled = (what: string): Error =>
  new Error(
    `[mica] ${what} was asked for before services/Phones.ts installed its resolver. A ` +
      `device-owned action cannot run without knowing which phone it is for; import the ` +
      `services barrel, or install a resolver in the test.`
  );

/**
 * The phone the caller of a request is on.
 *
 * Throws a `PlayerFacingError` (from the resolver) for a player holding no phone on a server
 * that gates on one — there is no phone for their rows to belong to, and the phone is closed
 * for them anyway — and degrades to the citizen's identity phone where no phone identity can
 * be had at all. `services/Phones.ts` has the three cases.
 */
export const phoneForRequest = (src: number, citizenid: string): Promise<string> => {
  if (!forRequest) throw notInstalled('the phone for a request');
  return forRequest(src, citizenid);
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
