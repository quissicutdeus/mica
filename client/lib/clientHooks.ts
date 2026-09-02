// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The client-side step a contracted action runs before its request leaves the client.
 *
 * A contract marks an action `clientPrepared` when only the game client can supply part
 * of its payload — `media:shareLocation` needs the street name at the player's position,
 * and `GetStreetNameAtCoord` exists nowhere else. Before MICA-213 that step was a private
 * `ServiceProxy` in `client/services/Location.ts`, with its own NUI callback and its own
 * reply subscription, and the subscription was forgotten once (e1edda1): every share waited
 * out the 15-second timeout for a row the server had already written.
 *
 * Now the step is registered here by service and action, and the generic relay runs it.
 * The relay owns the subscription, so there is no second one to forget; and because the
 * contract says which actions need a hook, the relay refuses to forward a prepared action
 * that has none registered rather than sending a payload the server will refuse.
 */
export type ClientHook = (data: unknown) => unknown | Promise<unknown>;

const hooks = new Map<string, ClientHook>();

const key = (service: string, action: string): string => `${service}:${action}`;

export function registerClientHook(service: string, action: string, hook: ClientHook): void {
  if (hooks.has(key(service, action))) {
    throw new Error(
      `[clientHooks] '${service}:${action}' already has a hook. Two hooks for one action ` +
        'would each believe they were the only preparation step.'
    );
  }
  hooks.set(key(service, action), hook);
}

export function clientHookFor(service: string, action: string): ClientHook | undefined {
  return hooks.get(key(service, action));
}
