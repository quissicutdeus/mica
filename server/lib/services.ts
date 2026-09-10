// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Every service name the server answers to.
 *
 * A service is a named group of server actions — the `<service>` segment of
 * `mica:<side>:<service>:<action>`. Most are backed by a table and declared with
 * `defineService`, but not all: `phone` is pure signalling, and `shell` only ever pushes
 * outward.
 *
 * This exists so nothing has to keep a list of the ones that are different. It used to:
 * `eventNames.test.ts` hard-coded `NON_APP_SEGMENTS = ['shell', 'admin']` plus a second
 * exception for `bank` and `phone`, because the vocabulary called everything an "app" and
 * four of them plainly were not. A name that needs a written-down list of things it does
 * not apply to is the wrong name.
 *
 * Now a service declares itself where it is defined, and the test reads the registry.
 */
const services = new Set<string>();

/**
 * The one app each service belongs to, for the services that declared one (MICA-234).
 *
 * Declared by the service itself — `app` on its `defineService` or `ServiceEndpoint` — so this
 * directory never names an app: an add-on the Store installs is not in this repository for core
 * to list, and `sdk/coreBoundary.test.ts` holds `server/lib` to that. `lib/ownerConfig.ts` reads
 * it to decide which services a disabled app takes down.
 */
const appOf = new Map<string, string>();

/**
 * Declare a service, and optionally the app it belongs to. Returns the id so it can be used
 * inline.
 *
 * A service may be registered more than once (`shell` has two endpoints), but never as two
 * different apps' — that is two owners each believing a disable switches it off, so it fails
 * at resource start rather than refusing for whichever registered last.
 */
export const registerService = (id: string, app?: string): string => {
  services.add(id);
  if (app !== undefined) {
    const existing = appOf.get(id);
    if (existing !== undefined && existing !== app) {
      throw new Error(`registerService('${id}'): already declared as '${existing}', not '${app}'.`);
    }
    appOf.set(id, app);
  }
  return id;
};

/** Every declared service name, table-backed or not. */
export const knownServices = (): string[] => [...services];

/** The app a service declared, or null when it declared none. */
export const appOfService = (id: string): string | null => appOf.get(id) ?? null;

/** Every service that declared an app, with that app. */
export const serviceApps = (): ReadonlyMap<string, string> => new Map(appOf);

/**
 * Every custom action registered this process, as `<service>:<action>`.
 *
 * "Custom" means it went through `ServiceEndpoint.registerEvent` — a handler somebody wrote —
 * rather than being one of the four `registerCrudEvents` derives from a column declaration.
 * That distinction is the whole point of the list: the generic four are validated by the
 * write allowlist and `columnRules`, and the custom ones are validated by a contract, so
 * "which actions need a contract entry?" has to be answered by how an action was registered
 * and never by what it is called. Several services disable the generic `create` and hand-write
 * their own, and that one is custom.
 *
 * Read by `reachability.test.ts` to check the surface in both directions: every custom action
 * is declared in a contract, and every declared action is registered. A contract entry nobody
 * registers is the more interesting half — it is an action the web believes it can call.
 */
const customActions = new Set<string>();

export const registerCustomAction = (service: string, action: string): void => {
  customActions.add(`${service}:${action}`);
};

/** Every `<service>:<action>` a hand-written handler answers. */
export const registeredCustomActions = (): string[] => [...customActions];
