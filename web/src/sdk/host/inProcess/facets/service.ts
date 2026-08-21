import { registerFacet } from '../../current';
import { fetchNui } from '../../../../nui/fetchNui';
import { GENERIC_SERVICE_ACTION } from '@shared/rpc';

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
 * ```ts
 * const journal = useService('journal');
 * const entries = await journal.call<Entry[]>('get', {}, []);
 * await journal.call('create', { title, body });
 * ```
 *
 * ## What this does not change
 *
 * **Authority.** `ServiceEndpoint` still authenticates the caller, rate-limits per
 * `(source, service, action)` and reduces the payload to the schema's allowlist. A NUI
 * request was never proof of intent and is not now (§2.9) — this widens who can *ask*,
 * not what the server agrees to.
 *
 * **Whose service.** The id is your own app id, or `<appId>_<anything>` for a second
 * table of yours. `sdk/permissions.test.ts` fails any other literal and any non-literal.
 *
 * **The named routes.** They stay, and `routes.test.ts` keeps cross-referencing them
 * against `fetchNui` calls, server registrations and the browser mock. That check catches
 * the missing-layer bug that silently does nothing in game, and it is worth keeping for
 * in-tree apps. This is the path for apps the table cannot cover.
 *
 * ## What you still have to do yourself
 *
 * There is no store here, and that is deliberate rather than unfinished. `createCrudStore`
 * and `createPagedStore` live in core because core's own services use them; an add-on
 * holds its own state in its own module, which is the one part of being an add-on that is
 * genuinely different rather than accidentally so.
 */
export function service(serviceId: string) {
  return {
    id: serviceId,

    /**
     * Call one action and wait for the reply.
     *
     * `defaultValue` behaves as it does everywhere else in the SDK: a failed round trip
     * resolves to it rather than throwing, so a missing server half degrades to an empty
     * list instead of a crashed app. Omit it when a failure should surface — a write
     * wrapped in `useAppAction` wants the error so it can toast it.
     */
    call: <T = unknown>(action: string, data?: unknown, defaultValue?: T): Promise<T> =>
      fetchNui<T>(
        GENERIC_SERVICE_ACTION,
        { service: serviceId, action, data },
        defaultValue === undefined ? undefined : { defaultValue }
      )
  };
}

registerFacet('service', service);
