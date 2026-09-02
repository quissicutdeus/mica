// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { fetchNui } from './fetchNui';
import { GENERIC_SERVICE_ACTION } from '@gphone/shared/rpc';
import type {
  ActionInput,
  ActionOutput,
  ContractAction,
  ServiceContract
} from '@gphone/shared/contract';

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
 */
export function call<C extends ServiceContract, A extends ContractAction<C>>(
  contract: C,
  action: A,
  input: ActionInput<C, A>
): Promise<ActionOutput<C, A>> {
  return fetchNui<ActionOutput<C, A>>(GENERIC_SERVICE_ACTION, {
    service: contract.id,
    action,
    data: input
  });
}

/**
 * The read form: a failure or an error reply answers `defaultValue` instead of throwing,
 * with the same console line `fetchNui` prints for a defaulted read, so the e2e fixture
 * still sees it.
 */
export function callOr<C extends ServiceContract, A extends ContractAction<C>, D>(
  contract: C,
  action: A,
  input: ActionInput<C, A>,
  defaultValue: D
): Promise<ActionOutput<C, A> | D> {
  return fetchNui<ActionOutput<C, A> | D>(
    GENERIC_SERVICE_ACTION,
    { service: contract.id, action, data: input },
    { defaultValue }
  );
}
