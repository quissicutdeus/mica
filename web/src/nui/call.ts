// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { fetchNui } from './fetchNui';
import { GENERIC_SERVICE_ACTION } from '@mica/shared/rpc';
import type { DeviceId } from '@mica/shared/devices';
import type {
  ActionInput,
  ActionOutput,
  ContractAction,
  ServiceContract
} from '@mica/shared/contract';

/**
 * Call a contracted action by its declaration, not by a string (MICA-213).
 *
 * A string-named `fetchNui` call names an action the compiler cannot check against
 * anything: a typo, a payload the server refuses, or a route nobody added to
 * `shared/routes.ts` all look identical at the call site and are found in game. This takes
 * the contract object and one of its action names, so the payload is typed by the
 * declared `input`, the reply by the declared `output`, and a name the contract does not
 * declare does not compile.
 *
 * It rides the generic service action rather than a per-action NUI callback, the same
 * door an add-on's `useService(id).call(...)` goes through. That is the point: the relay in
 * `client/services/Relay.ts` subscribes the reply per request and runs the contract's
 * client hook where one is declared, so a contracted action needs **no row** in
 * `shared/routes.ts` and no hand-written subscription on the client. The browser mock
 * answers it under the scoped key `'<service>:<action>'`, and
 * `server/__tests__/routes.test.ts` checks every call site here against both the server's
 * registered events and that scoped mock.
 *
 * `device` names the identity the request speaks for (MICA-264). Leave it out and `fetchNui`
 * stamps whichever device is on screen when the request is sent, which is right for almost
 * every call; name it only when the request belongs to a device that may no longer be up — a
 * debounced settings write queued on the phone that flushes after the tablet was raised.
 */
export function call<C extends ServiceContract, A extends ContractAction<C>>(
  contract: C,
  action: A,
  input: ActionInput<C, A>,
  options?: { device?: DeviceId }
): Promise<ActionOutput<C, A>> {
  return fetchNui<ActionOutput<C, A>>(
    GENERIC_SERVICE_ACTION,
    envelope(contract, action, input, options?.device)
  );
}

/**
 * The read form: a failure or an error reply answers `defaultValue` instead of throwing,
 * with the same console line `fetchNui` prints for a defaulted read, so the e2e fixture
 * still sees it. `quiet` is `fetchNui`'s own: no console line either, for the few calls
 * that legitimately fire before a character is loaded (`services/settings.ts` says why).
 */
export function callOr<C extends ServiceContract, A extends ContractAction<C>, D>(
  contract: C,
  action: A,
  input: ActionInput<C, A>,
  defaultValue: D,
  options?: { quiet?: boolean; device?: DeviceId }
): Promise<ActionOutput<C, A> | D> {
  return fetchNui<ActionOutput<C, A> | D>(
    GENERIC_SERVICE_ACTION,
    envelope(contract, action, input, options?.device),
    { defaultValue, quiet: options?.quiet }
  );
}

/**
 * `{ service, action, data }`, and `device` only when one was named: an absent key is what
 * tells `fetchNui` to stamp the active device, and a call that names none must keep the
 * exact three-key shape every `toHaveBeenCalledWith` in the suite asserts.
 */
const envelope = (
  contract: ServiceContract,
  action: string,
  data: unknown,
  device: DeviceId | undefined
) =>
  device === undefined
    ? { service: contract.id, action, data }
    : { service: contract.id, action, data, device };
