// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Infer, Schema, StandardSchemaV1 } from './schema';

/**
 * One declaration of a service's custom actions, read by all three bundles.
 *
 * The CRUD actions `ServiceEndpoint` **derives** from the column declaration are not here, and
 * must not be: the schema already produces the write allowlist and the per-column rules that
 * validate them, so restating one as an input schema would be a second source of truth for the
 * same table. What counts is how an action was registered, never what it is called — a service
 * that disables the generic `create` and hand-writes its own has written a custom action, and
 * that one belongs here like any other. `ServiceEndpoint.registerGeneric` throws if a contract
 * claims an action the endpoint is deriving.
 *
 * What each bundle takes from it:
 *
 * - **server** — `input` is parsed before the handler runs, so the handler receives a value
 *   of a known shape instead of `unknown` plus a page of hand-rolled coercion.
 * - **client** — `clientPrepared` says an action's relay must run a native before forwarding,
 *   so a generic relay can refuse to forward one it has no hook for rather than sending an
 *   incomplete payload the server then rejects.
 * - **web** — the typed call, and the mock, derive from the same `input`/`output` pair.
 */
export interface ActionContract {
  /**
   * What a client may send. Any Standard Schema v1 — `s.object({...})` from
   * `shared/schema.ts` for everything in this repo, or an add-on's own zod/valibot schema.
   *
   * `responseType()` is deliberately not assignable here: it validates nothing, and a
   * declaration-only marker in an input position would be an action that accepts anything
   * while looking like it did not.
   */
  input: Schema & { readonly '~responseOnly'?: undefined };
  /**
   * What the action answers with. Declaration-only — the server does not validate its own
   * replies, because a wrong reply is a bug here rather than an attack from there. Either a
   * real schema, or `responseType<T>()` when the answer is a domain type from
   * `shared/types.ts` that would be worse for being restated as a schema.
   */
  output?: Schema;
  /**
   * This action's client relay must run a native before it forwards.
   *
   * Today exactly one action: `media:shareLocation` needs the street name at the player's
   * coordinates, which only the game client can answer. Marked here so a generic relay can
   * tell "no hook registered for this action" apart from "this action needs no hook", rather
   * than forwarding a payload the server will refuse for a missing field.
   */
  clientPrepared?: true;
}

export interface ServiceContract<
  A extends Record<string, ActionContract> = Record<string, ActionContract>
> {
  /** Matches the `<service>` segment of `gos:server:<service>:<action>`. */
  readonly id: string;
  readonly actions: A;
}

/** The action names a contract declares. */
export type ContractAction<C extends ServiceContract> = keyof C['actions'] & string;

/** What the handler for one action receives, after `input` has parsed the payload. */
export type ActionInput<C extends ServiceContract, A extends string> = A extends keyof C['actions']
  ? C['actions'][A]['input'] extends StandardSchemaV1
    ? Infer<C['actions'][A]['input']>
    : unknown
  : unknown;

/** What one action answers with, where the contract said. `unknown` where it did not. */
export type ActionOutput<C extends ServiceContract, A extends string> = A extends keyof C['actions']
  ? C['actions'][A]['output'] extends StandardSchemaV1
    ? Infer<C['actions'][A]['output']>
    : unknown
  : unknown;

/**
 * Every contract declared this process, by service id.
 *
 * The same mechanism `declaredServices` uses in `server/lib/defineService.ts`, and for the
 * same reason: declaring the thing is the registration, so there is no second list to forget.
 * Populated by importing `shared/contracts` — the generated barrel `export *`s every file,
 * and evaluating a file runs its `defineContract` call.
 */
const registry = new Map<string, ServiceContract<Record<string, ActionContract>>>();

/**
 * Declare a service's custom actions.
 *
 * ```ts
 * export const mediaContract = defineContract({
 *   id: 'media',
 *   actions: {
 *     shareLocation: { input: s.object({ label: s.string({ max: 255 }).optional() }) }
 *   }
 * });
 * ```
 *
 * **Where the file goes, and it is not always `shared/contracts/`.** That directory is core,
 * and core may not name an app the Store installs — `sdk/coreBoundary.test.ts` enforces it,
 * because an add-on is not in this repository and anything core does by naming one works for
 * the apps shipped in-tree and silently does not work for anybody else's. So an add-on
 * declares its contract in **its own resource**, beside the `defineService` call it belongs
 * to; `server/services/Notes.ts` is the in-tree example, and it is the same shape an external
 * add-on writes. `shared/contracts/` holds the contracts core itself owns, where all three
 * bundles can read them.
 */
export function defineContract<const A extends Record<string, ActionContract>>(definition: {
  id: string;
  actions: A;
}): ServiceContract<A> {
  const { id, actions } = definition;

  if (!id || typeof id !== 'string') {
    throw new Error("defineContract: 'id' is required and must be a string.");
  }
  if (registry.has(id)) {
    throw new Error(
      `defineContract('${id}'): a contract for that service is already declared. Two files ` +
        'claiming one service would each believe they were the whole reachable surface.'
    );
  }
  for (const [action, spec] of Object.entries(actions)) {
    if (!spec || typeof spec !== 'object' || !spec.input) {
      throw new Error(
        `defineContract('${id}'): action '${action}' declares no input schema. An action ` +
          'that accepts anything is the thing this file exists to stop.'
      );
    }
  }

  const contract: ServiceContract<A> = { id, actions };
  registry.set(id, contract as ServiceContract<Record<string, ActionContract>>);
  return contract;
}

/** The contract for a service id, or undefined if it declared none. */
export function contractFor(id: string): ServiceContract | undefined {
  return registry.get(id);
}

/** Every declared contract, for the suites that check both directions of the surface. */
export function allContracts(): ServiceContract[] {
  return [...registry.values()];
}

/**
 * Action names, sorted, for enumeration and for a stable assertion in a test.
 *
 * `.sort()` rather than `.toSorted()`: this file is read by `client/`, whose lib is es2021
 * (FiveM's client-side V8 is older than the server's), and `Object.keys` already hands back a
 * fresh array so there is nothing to mutate out from under a caller.
 */
export function actionsOf(contract: ServiceContract): string[] {
  return Object.keys(contract.actions).sort();
}

/** Whether an action's relay has to run a native before forwarding. */
export function isClientPrepared(contract: ServiceContract, action: string): boolean {
  return contract.actions[action]?.clientPrepared === true;
}

/**
 * Declare a response shape without writing a validator for it.
 *
 * The server does not check its own replies, so an `output` exists to tell the web and an
 * add-on what comes back. Where that is already a type — `Conversation[]`, `MailRow` — a
 * schema restating it would be a second declaration that can disagree with the first. This is
 * a phantom: it carries the type and validates nothing, which is why the brand keeps it out
 * of an `input` position.
 */
export function responseType<T>(): Schema<T> & { readonly '~responseOnly': true } {
  return {
    '~standard': {
      version: 1,
      vendor: 'gos',
      validate: (value: unknown) => ({ value: value as T })
    },
    '~responseOnly': true
  };
}
