// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { GENERIC_SERVICE_ACTION } from '@mica/shared/rpc';
import { DEFAULT_DEVICE, isDeviceId, type DeviceId } from '@mica/shared/devices';

/**
 * What a handler knows about the request beyond its payload (MICA-264): the device it speaks
 * for, read off the generic envelope exactly as `parseGenericRequest` reads it on the server —
 * absent means the phone. A named route carries none here, as it carries none from the web in
 * game, so it is the phone too. Only the per-device mocks (`perDevice.ts`) read it.
 */
export interface MockContext {
  device: DeviceId;
}

// Deliberately `any`: each handler in a service file's `mocks` declares its own,
// more specific payload shape than this container type — arrow-function
// object properties get strict (non-bivariant) parameter checking in
// TypeScript, so `unknown` here would reject every handler whose declared
// parameter isn't itself `unknown`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see comment above
export type MockHandler<T = any> = (data?: any, context?: MockContext) => Promise<T> | T;

/**
 * Every service's mocks, one file each under `./services/` (MICA-323).
 *
 * Collected by glob so adding a service is adding a file: nothing here names one. Each file
 * exports `const mocks: Record<string, MockHandler> = { … }` — that exact declaration, because
 * `server/__tests__/routes.test.ts` reads it as text (it runs under the root Vitest project,
 * with no Vite and so no `import.meta.glob`) to cross-reference every key against the routes,
 * the contracts and the server's registered events.
 *
 * **Eager, and that is load-bearing.** An eager glob compiles to static imports, so every
 * service file evaluates during the bundle's initial, synchronous module evaluation, exactly
 * as when this was one file. `services/settings.ts` snapshots `localStorage` at module scope
 * and depends on doing it before the phone's own boot writes anything (MICA-287 round 5); a
 * lazy glob would take that snapshot after.
 */
const serviceMocks = import.meta.glob<Record<string, MockHandler>>(
  ['./services/*.ts', '!./services/*.test.ts'],
  { eager: true, import: 'mocks' }
);

/**
 * The merged table, refusing a key two files both answer.
 *
 * Within one file an object literal resolves a repeated key silently in favour of the later
 * one (`services/media.ts` overrides the generic `getMedia` that way, on purpose); across
 * files the winner would be glob order, which nobody chose. A collision is a startup error
 * rather than a coin toss.
 */
export const mockRegistry: Readonly<Record<string, MockHandler>> = (() => {
  const merged: Record<string, MockHandler> = {};
  const owner = new Map<string, string>();
  for (const [file, mocks] of Object.entries(serviceMocks)) {
    if (!mocks || typeof mocks !== 'object') {
      throw new Error(`[MockRegistry] ${file} does not export \`const mocks = { … }\``);
    }
    for (const [key, handler] of Object.entries(mocks)) {
      const previous = owner.get(key);
      if (previous) {
        throw new Error(`[MockRegistry] '${key}' is answered by both ${previous} and ${file}`);
      }
      owner.set(key, file);
      merged[key] = handler;
    }
  }
  return merged;
})();

/**
 * `?mica_boot=unauthenticated` presents the mock the way a fresh server presents the
 * real one (MICA-266): `bootstrapStores` preloads before the framework has loaded a
 * character, `ServiceEndpoint` refuses every `svc` call with `{ error: 'Player not
 * authenticated' }`, and the phone recovers only once `server/lib/shell.ts`'s
 * `pushRehydrate` sends the `rehydrateShell` NUI message that `resetBootstrapState` +
 * `bootstrapStores(true)` answer. The mock has no such boot sequence of its own — every
 * call has always just answered — so this state was unreachable in the browser and in
 * Playwright, and the `derived_inert` warning MICA-266 investigates only shows up inside
 * it.
 *
 * Scoped to the generic `svc` action alone, in `getMockData` below, because that is the
 * only door the real refusal sits behind: `getCitizenId` and `getBankBalance`
 * (`services/account.ts`) are answered by the *client*'s own `RegisterNuiCallbackType`
 * handlers (`client/client.ts`), never routed through `ServiceEndpoint`, so they keep
 * answering here too rather than joining a failure they would never see in game.
 */
let mockAuthenticated =
  (typeof window === 'undefined'
    ? null
    : new URLSearchParams(window.location.search).get('mica_boot')) !== 'unauthenticated';

if (typeof window !== 'undefined') {
  window.addEventListener('message', (event: MessageEvent) => {
    const { action } = (event.data ?? {}) as { action?: unknown };
    if (action === 'rehydrateShell') mockAuthenticated = true;
  });
}

/**
 * The generic service call, unwrapped so the mocks see the action they already know.
 *
 * `useService('journal').call('get')` arrives here as one `svc` action carrying
 * `{ service, action, data }`. Dispatching it to a `journal:get` key means an app using
 * the generic path is mockable exactly like every other one — and without this it would
 * be dead in `pnpm dev` and in Playwright, which is the failure §8 says a missing mock
 * always is.
 *
 * Falls back to the bare action name, so a service whose actions are also named routes
 * needs no second fixture.
 */
function resolveGeneric(
  data?: unknown
): { key: string; payload: unknown; context: MockContext } | null {
  if (!data || typeof data !== 'object') return null;
  const { service, action, data: inner, device } = data as Record<string, unknown>;
  if (typeof service !== 'string' || typeof action !== 'string') return null;

  const scoped = `${service}:${action}`;
  return {
    key: mockRegistry[scoped] ? scoped : action,
    payload: inner,
    context: { device: isDeviceId(device) ? device : DEFAULT_DEVICE }
  };
}

async function getMockData(
  eventName: string,
  data?: unknown,
  context: MockContext = { device: DEFAULT_DEVICE }
): Promise<unknown> {
  if (eventName === GENERIC_SERVICE_ACTION) {
    // Keyed as `ServiceEndpoint` keys it, so `fetchNui` hands back the same `ServiceRefusal`
    // the game would and a key check (`host/facets/storage.ts`) is exercised here (MICA-310).
    if (!mockAuthenticated) {
      return { error: 'Player not authenticated', key: 'server.notAuthenticated' };
    }

    const resolved = resolveGeneric(data);
    // Malformed shape (not even `{ service, action }`) is a caller bug, not a missing
    // mock — the real `ServiceEndpoint` answers a bad request rather than crashing the
    // page over it, so this stays a graceful `null` rather than joining the throw below.
    if (!resolved) {
      console.warn('[MockRegistry] Malformed generic service request', data);
      return null;
    }
    return getMockData(resolved.key, resolved.payload, resolved.context);
  }

  const handler = mockRegistry[eventName];
  if (handler) {
    return handler(data, context);
  }
  // A missing mock used to warn and answer `null`, which reads to the caller as "the
  // server sent nothing" rather than "nobody wired this up" — the exact failure this
  // registry exists to make visible instead of hidden. Throwing surfaces it the same
  // way a real unhandled route would.
  throw new Error(`[MockRegistry] No handler found for event: ${eventName}`);
}

export const MockRegistry = {
  has: (eventName: string) =>
    eventName === GENERIC_SERVICE_ACTION || Boolean(mockRegistry[eventName]),
  handle: (eventName: string, data?: unknown) => getMockData(eventName, data)
};
