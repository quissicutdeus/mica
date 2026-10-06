// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  AddonActionInput,
  AddonActionName,
  AddonActionOutput,
  AddonServiceDeclaration
} from '@mica/shared/addonService';
import type { Facets } from './facets';
import { guarded } from './guard';

/**
 * What `call` takes after the action name, for one declared action.
 *
 * The input may be left out only when the declaration lets it be — an action whose fields
 * are all `optional`, `{}` included, which the server reads as `{}` (`addonInputSchema`).
 * An action with a required field needs its input, so forgetting it is a compile error
 * rather than an `invalid_args` toast.
 */
type DeclaredCallArgs<D extends AddonServiceDeclaration, A extends AddonActionName<D>> =
  object extends AddonActionInput<D, A>
    ? [input?: AddonActionInput<D, A>, defaultValue?: AddonActionOutput<D, A>]
    : [input: AddonActionInput<D, A>, defaultValue?: AddonActionOutput<D, A>];

/**
 * `useService(declaration)`'s answer: the same object the string form returns, with `call`
 * typed from the declaration. Nothing about it differs at run time.
 */
interface DeclaredService<D extends AddonServiceDeclaration> {
  readonly id: D['id'];
  /**
   * Call one declared action. `action` is one of the declaration's names, `input` is what
   * its fields parse to, and the answer is what `addonOutput<T>()` declared — `unknown`
   * when it declared nothing, since the server never checks an add-on's answers.
   *
   * `defaultValue` behaves as on the string form: a failed round trip resolves to it rather
   * than throwing. Omit it when a failure should surface.
   */
  call<A extends AddonActionName<D>>(
    action: A,
    ...args: DeclaredCallArgs<D, A>
  ): Promise<AddonActionOutput<D, A>>;
}

/**
 * Talk to your own server service.
 *
 * Every other data hook — `useNotes`, `useContacts`, `useMessages` — is core code named
 * after an app, backed by a store in `web/src/services/` and a row per action in
 * `shared/routes.ts`. That works for apps shipped in this repository and is unavailable to
 * anybody else: an app installed from the Store cannot add a hook to the SDK, a store to
 * core, or a route to the table. Which meant the add-on path supported UI-only apps, and
 * `sdk/coreBoundary.test.ts` measures exactly how much of Notes and Blabber depends on
 * being first-party.
 *
 * This is the general door. One NUI callback carries `{ service, action, data }` and the
 * client derives the event from the two segments, so an app reaches its own service
 * without core knowing its name.
 *
 * ## Two forms
 *
 * **A declaration** (MICA-308), for an add-on whose server half is its own FiveM resource
 * registered through `exports.mica:RegisterService`. The object you pass is the one your
 * resource registers, so the UI's types and the server's validation read one source:
 *
 * ```ts
 * // src/service.ts
 * export const journal = defineAddonService({
 *   id: 'journal',
 *   actions: {
 *     create: { input: { title: { type: 'string', max: 80 } } },
 *     list: { input: {}, output: addonOutput<Entry[]>() }
 *   }
 * });
 *
 * // anywhere in the app
 * const entries = await useService(journal).call('list', {}, []); // Entry[]
 * await useService(journal).call('create', { title }); // a typo in a name fails to compile
 * ```
 *
 * It sends exactly what `useService(journal.id)` sends. The types are a convenience for the
 * caller and a promise about nothing: the server parses every payload against the
 * declaration it was handed, whatever this side believed.
 *
 * **A string**, for any service — a core app's own `defineService` table, or an add-on that
 * has not written a declaration:
 *
 * ```ts
 * const journal = useService('journal');
 * const entries = await journal.call<Entry[]>('get', {}, []);
 * await journal.call('create', { title, body });
 * ```
 *
 * ## What this does not change
 *
 * **Authority.** The server still authenticates the caller, rate-limits per
 * `(source, service, action)` and parses the payload before a handler sees it. A NUI
 * request was never proof of intent and is not now (§2.9) — this widens who can *ask*,
 * not what the server agrees to.
 *
 * **Whose service.** The id — the string, or the declaration's `id` — is your own app id,
 * or `<appId>_<anything>` for a second service of yours. A sandboxed add-on asking for
 * another is refused by the shell before anything is sent; in this repo
 * `sdk/permissions.test.ts` fails any other literal, any non-literal, and any declaration
 * it cannot trace to a `defineAddonService` call inside the app's own directory.
 *
 * **The named routes.** They stay, and `routes.test.ts` keeps cross-referencing them
 * against `fetchNui` calls, server registrations and the browser mock. That check catches
 * the missing-layer bug that silently does nothing in game, and it is worth keeping for
 * in-tree apps. This is the path for apps the table cannot cover.
 *
 * ## When the server says no
 *
 * A call with no `defaultValue` rejects. A refusal the server keyed — a rate limit, an
 * unauthenticated caller, an app the owner switched off, the generic failure — rejects with a `ServiceRefusal` whose
 * `message` is ready to show and whose `key` is the catalog key it named, so ask
 * `isRefusal(error, 'server.rateLimited')` rather than comparing the message, which is
 * translated and may be reworded (MICA-310). Your own handler's `addonError(...)` carries no
 * key and rejects with a plain `Error`. All of this holds in a sandboxed frame too: the key
 * crosses `postMessage` beside the message, and nothing else of the error does.
 *
 * ## What you still have to do yourself
 *
 * There is no store here, and that is deliberate rather than unfinished. `createCrudStore`
 * and `createPagedStore` live in core because core's own services use them; an add-on
 * holds its own state in its own module, which is the one part of being an add-on that is
 * genuinely different rather than accidentally so.
 */
export function useService<const D extends AddonServiceDeclaration>(
  declaration: D
): DeclaredService<D>;
// Last on purpose: the string form is the general one, and the overload a reader of the
// type (`ReturnType`, `publicSurface.test.ts`'s frozen hook shape) sees.
export function useService(serviceId: string): ReturnType<Facets['service']>;
export function useService(
  target: string | AddonServiceDeclaration
): ReturnType<Facets['service']> {
  const serviceId = typeof target === 'string' ? target : target.id;
  return guarded('useService', serviceId.split('_')[0]).facets.service(serviceId);
}
