// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The qb-phone net events micaOS answers (MICA-222).
 *
 * Hundreds of qb-core scripts fire these to mail or notify a player's phone. Net events are
 * global rather than keyed by resource, so micaOS can listen for them directly and a server
 * replacing qb-phone edits none of those scripts. Every name lives here, once, so the server
 * and client handlers, the start-up line that says what is answered, the README's "coming
 * from qb-phone" list and `server/__tests__/eventNames.test.ts` all read the same set -- a
 * foreign-prefixed name registered anywhere else fails that test.
 *
 * **Everything else with the `qb-phone:` prefix is deliberately not answered.** The rest of
 * qb-phone's events are its own UI talking to its own server half -- calls, adverts, tweets,
 * garage lists -- which no third-party script has reason to fire and micaOS has its own
 * shape for. A script that does fire one gets what FiveM gives any event with no listener:
 * nothing, silently. There is no way to log that from here; an event nobody listens for
 * never reaches this resource.
 */
export const QB_PHONE_SERVER_EVENTS = {
  /** `TriggerEvent('qb-phone:server:sendNewMail', mailData)` with the player as `source`. */
  sendNewMail: 'qb-phone:server:sendNewMail',
  /** `TriggerEvent('qb-phone:server:sendNewMailToOffline', citizenid, mailData)`. */
  sendNewMailToOffline: 'qb-phone:server:sendNewMailToOffline'
} as const;

export const QB_PHONE_CLIENT_EVENTS = {
  /** `TriggerClientEvent('qb-phone:client:CustomNotification', src, title, text, icon, color, timeout)`. */
  customNotification: 'qb-phone:client:CustomNotification'
} as const;

/** Every foreign name micaOS listens for, for the gate and the start-up line. */
export const QB_PHONE_ANSWERED: readonly string[] = [
  ...Object.values(QB_PHONE_SERVER_EVENTS),
  ...Object.values(QB_PHONE_CLIENT_EVENTS)
];
