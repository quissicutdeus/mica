// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { onDestroy } from 'svelte';
import { MICA_ADDON_MOCK_MARKER } from '@mica/shared/addonDev';
import {
  ADDON_ERROR_MESSAGE_MAX,
  addonActionSchemas,
  type AddonMockDefinition,
  type AddonMockTools,
  type AddonServiceDeclaration
} from '@mica/shared/addonService';
import { APP_EVENT_NAME_PATTERN } from '@mica/shared/appEvents';
import { facets, registerFacet } from '../current';
import type { Facets } from '../facets';
import { ServiceRefusal } from '../../lib/errors';
import type { AppEvent } from '../../vocabulary/shell';
import type { AppManifest } from '../../manifest';

/**
 * An add-on's server half, mocked inside its own frame, for the dev loop (MICA-311).
 *
 * `installAddonMock(mock)` replaces two facets **in this frame only**: `service`, so that
 * `useService(id)` for the mocked declaration's id is answered here instead of crossing to the
 * shell, and `appEvents`, so that the mock's `push` reaches `useAppEvents(id)` listeners. The
 * shell never learns a mock exists — it is not a path into the shell, and nothing in the shell
 * trusts it. Any other service id falls through to the real twin, so the shell's own
 * own-service check still refuses a foreign one exactly as it does in game.
 *
 * Install after the iframe facet set is registered (importing `@mica/sdk` does that, through
 * `bootAddOn`) and before `bootAddOn` mounts the app. The template's dev entry does both in
 * that order, and only when Vite's mode is `development`; a production build refuses
 * `@mica/sdk/dev` outright.
 *
 * **What a call answers matches the real path, failure included.** The real chain is server
 * handler → `ServiceEndpoint` reply → the shell's `fetchNui` → the frame's `remoteCall`; the
 * three things it can do to an answer are copied here:
 *
 * - **Input** is parsed against the declaration with `addonActionSchemas`, before the handler
 *   runs. A refusal answers the first issue's message, as `SchemaError` does.
 * - **`addonError(message)`** answers its message, whitespace collapsed and cut to
 *   `ADDON_ERROR_MESSAGE_MAX`. A throw, a malformed `{ error }`, an action the declaration does
 *   not name, or an answer that is not JSON answers the generic failure, with the cause on the
 *   console (where the server log would have it).
 * - **A failure** rejects with a plain `Error` carrying that message — or, when the caller
 *   passed a `defaultValue`, resolves to it, as `fetchNui` does. A `null` answer to a call with
 *   a default, or a non-array answer where the default is an array, resolves to the default.
 *   The generic failure rejects with a `ServiceRefusal` keyed `server.generic` instead, as the
 *   real one does (MICA-310); `addonError` and schema refusals carry no key on either path.
 *
 * Answers and inputs make the JSON round trip the real ones make, so a `Date` arrives as a
 * string and `undefined` drops out here exactly as it would in game.
 *
 * **Not mocked:** the shell's per-frame rate limit, the server's per-action limiter and
 * handler timeout, and the 15-second client timeout. A mock answers as fast as it runs.
 */

/** The citizen every mocked call is made as. Not a real one; nothing here reaches a server. */
const DEV_CITIZENID = 'DEV00001';
/** The player source every mocked call is made from. */
const DEV_SOURCE = 1;

/** `server/lib/errors.ts`'s `GENERIC_ERROR_MESSAGE`, in English: the frame has no server catalog. */
const GENERIC_FAILURE = 'Something went wrong. Try again in a moment.';
/** `server/lib/errors.ts`'s `GENERIC_ERROR_KEY`, which the real generic failure carries. */
const GENERIC_FAILURE_KEY = 'server.generic';
/** `@mica/shared/schema`'s `SchemaError` fallback, for a refusal with no issue message. */
const SHAPE_FAILURE = 'That request was not in the expected shape.';
/** `server/lib/addonServices.ts`'s `ADDON_ANSWER_MAX_BYTES`. */
const ANSWER_MAX_BYTES = 262_144;
/** `server/lib/appEvents.ts`'s `MAX_PAYLOAD_BYTES`: a push carries a reference, not a document. */
const PUSH_PAYLOAD_MAX_BYTES = 16_384;
/** The shell bus's per-app buffer, `shell/state/appEvents.ts`. */
const MAX_BUFFERED = 25;

type ServiceFacet = Facets['service'];
type AppEventsFacet = Facets['appEvents'];
type AppEventHandler = (event: AppEvent) => void;
type Outcome =
  { ok: true; value: unknown } | { ok: false; message: string; key?: string; cause?: unknown };

/** One installed mock: the declaration's validators, its handlers, and its own event bus. */
interface Installed {
  readonly id: string;
  readonly schemas: ReturnType<typeof addonActionSchemas>;
  handlers: Readonly<Record<string, unknown>>;
  readonly listeners: Map<string, Set<AppEventHandler>>;
  buffered: AppEvent[];
}

const installed = new Map<string, Installed>();
/** The facets this frame had before the first install, which everything unmocked reaches. */
let original: { service: ServiceFacet; appEvents: AppEventsFacet } | undefined;

const hasOwn = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

/** The JSON round trip a value makes on the real path, or `undefined` when it cannot. */
const jsonRoundTrip = (value: unknown): { json: string; value: unknown } | undefined => {
  let json: string | undefined;
  try {
    json = JSON.stringify(value === undefined ? null : value);
  } catch {
    return undefined;
  }
  if (json === undefined) return undefined;
  return { json, value: JSON.parse(json) as unknown };
};

const generic = (id: string, action: string, why: string, cause?: unknown): Outcome => {
  const where = `[${MICA_ADDON_MOCK_MARKER}] ${id}:${action}`;
  if (cause === undefined) console.error(`${where} ${why}`);
  else console.error(`${where} ${why}:`, cause);
  return { ok: false, message: GENERIC_FAILURE, key: GENERIC_FAILURE_KEY };
};

/** Answer one call the way the server would: parse, run, and shape the answer. */
async function answer(mock: Installed, action: string, data: unknown): Promise<Outcome> {
  const schema = hasOwn(mock.schemas, action) ? mock.schemas[action] : undefined;
  if (!schema) {
    return generic(mock.id, action, 'is not an action the declaration names');
  }

  // The payload crossed `postMessage` and then JSON to reach the server.
  const sent = data === undefined ? { value: undefined } : jsonRoundTrip(data);
  if (!sent) return generic(mock.id, action, 'was called with input that is not JSON');

  const parsed = schema['~standard'].validate(sent.value);
  if (parsed instanceof Promise) {
    return { ok: false, message: 'That value could not be checked.' };
  }
  if (parsed.issues) {
    return { ok: false, message: parsed.issues[0]?.message ?? SHAPE_FAILURE };
  }

  const handler = mock.handlers[action];
  if (typeof handler !== 'function') {
    return generic(mock.id, action, 'has no handler in the mock');
  }

  let reply: unknown;
  try {
    reply = await (handler as (c: string, i: unknown, s: number) => unknown)(
      DEV_CITIZENID,
      parsed.value,
      DEV_SOURCE
    );
  } catch (error) {
    return generic(mock.id, action, 'threw', error);
  }

  if (reply !== null && typeof reply === 'object' && hasOwn(reply, 'error')) {
    const message = (reply as { error?: { message?: unknown } }).error?.message;
    if (typeof message === 'string') {
      const text = message.replace(/\s+/g, ' ').trim();
      if (text) {
        return {
          ok: false,
          message:
            text.length > ADDON_ERROR_MESSAGE_MAX
              ? `${text.slice(0, ADDON_ERROR_MESSAGE_MAX - 1)}…`
              : text
        };
      }
    }
    return generic(mock.id, action, "answered an 'error' that is not { message = '…' }");
  }

  const out = jsonRoundTrip(reply);
  if (!out) return generic(mock.id, action, 'answered something that is not JSON');
  if (out.json.length > ANSWER_MAX_BYTES) {
    return generic(mock.id, action, `answered ${out.json.length} bytes, over ${ANSWER_MAX_BYTES}`);
  }
  return { ok: true, value: out.value };
}

/** `useService(id)`'s object for a mocked id, settling as `fetchNui` would. */
function mockedService(mock: Installed): ReturnType<ServiceFacet> {
  return {
    id: mock.id,
    call: async <T = unknown>(action: string, data?: unknown, defaultValue?: T): Promise<T> => {
      const hasDefault = defaultValue !== undefined;
      const outcome = await answer(mock, action, data);
      if (!outcome.ok) {
        if (hasDefault) {
          console.warn(
            `[${MICA_ADDON_MOCK_MARKER}] ${mock.id}:${action} returned an error; using the default.`,
            outcome.message
          );
          return defaultValue;
        }
        throw outcome.key
          ? new ServiceRefusal(outcome.key, outcome.message)
          : new Error(outcome.message);
      }
      const value = outcome.value;
      if (hasDefault) {
        if (value === null || value === undefined) return defaultValue;
        if (Array.isArray(defaultValue) && !Array.isArray(value)) return defaultValue;
      }
      return (value ?? defaultValue ?? null) as T;
    }
  };
}

/** Hand an event to the mock's listeners, or hold it for the next one, as the shell's bus does. */
function deliver(mock: Installed, event: AppEvent): void {
  const exact = mock.listeners.get(event.event);
  const wildcard = mock.listeners.get('*');
  const handlers = [...(exact ?? []), ...(wildcard ?? [])];
  if (handlers.length === 0) {
    mock.buffered.push(event);
    if (mock.buffered.length > MAX_BUFFERED) mock.buffered.shift();
    return;
  }
  for (const handler of handlers) {
    try {
      handler(event);
    } catch (error) {
      console.error(`[appEvents] Handler for '${event.app}:${event.event}' threw:`, error);
    }
  }
}

function subscribe(mock: Installed, event: string, handler: AppEventHandler): () => void {
  const set = mock.listeners.get(event) ?? new Set<AppEventHandler>();
  set.add(handler);
  mock.listeners.set(event, set);
  const mine = event === '*' ? mock.buffered : mock.buffered.filter((e) => e.event === event);
  if (mine.length > 0) {
    mock.buffered = mock.buffered.filter((e) => !mine.includes(e));
    for (const e of mine) handler({ ...e, replayed: true });
  }
  return () => {
    set.delete(handler);
  };
}

/** The mock's `push`: what `exports.mica:PushToApp` would deliver, checked as it would be. */
function pushFor(mock: Installed): AddonMockTools['push'] {
  return (event, payload) => {
    if (typeof event !== 'string' || !APP_EVENT_NAME_PATTERN.test(event)) {
      throw new Error(
        `[${MICA_ADDON_MOCK_MARKER}] push('${String(event)}'): an event name is lower_snake_case.`
      );
    }
    if (payload !== undefined && !isPlainObject(payload)) {
      throw new Error(
        `[${MICA_ADDON_MOCK_MARKER}] push('${event}'): a payload is a plain object or nothing.`
      );
    }
    const sent = jsonRoundTrip(payload ?? {});
    if (!sent) {
      throw new Error(`[${MICA_ADDON_MOCK_MARKER}] push('${event}'): the payload is not JSON.`);
    }
    if (sent.json.length > PUSH_PAYLOAD_MAX_BYTES) {
      throw new Error(
        `[${MICA_ADDON_MOCK_MARKER}] push('${event}'): payload is over ${PUSH_PAYLOAD_MAX_BYTES} ` +
          `bytes. A push carries a reference, not a document.`
      );
    }
    const envelope: AppEvent = {
      app: mock.id,
      event,
      payload: sent.value as Record<string, unknown>,
      at: Date.now(),
      replayed: false
    };
    // Later, as a real push arrives: never inside the handler call that occasioned it.
    setTimeout(() => deliver(mock, envelope), 0);
  };
}

/** `useAppEvents(id)` for a mocked id: the mock's own bus, beside the real subscription. */
function mockedAppEvents(
  mock: Installed,
  real: ReturnType<AppEventsFacet>
): ReturnType<AppEventsFacet> {
  const listen = (event: string, handler: AppEventHandler, offReal: () => void): (() => void) => {
    const offLocal = subscribe(mock, event, handler);
    try {
      onDestroy(offLocal);
    } catch {
      // Called outside a component: a permanent subscription, as on the real facet.
    }
    return () => {
      offLocal();
      offReal();
    };
  };
  return {
    on: <T = Record<string, unknown>>(event: string, handler: (e: AppEvent<T>) => void) =>
      listen(event, handler as AppEventHandler, real.on(event, handler)),
    onAny: (handler: AppEventHandler) => listen('*', handler, real.onAny(handler)),
    clear: () => {
      mock.buffered = [];
      real.clear();
    }
  };
}

/** What the frame's manifest says about which services it may call. */
type ServiceOwner = Pick<AppManifest, 'id' | 'services'>;

/**
 * The shell's `serviceAllowed`, answered inside the frame: the manifest's explicit `services`
 * when it declares them, otherwise the app's own id or `<appId>_<anything>`. A mock may answer
 * only an id the phone would let this app call, or it would hand the author a dev loop that
 * works for a service the game then refuses.
 */
function serviceAllowed(owner: ServiceOwner, id: string): boolean {
  if (owner.services) return owner.services.includes(id);
  return id === owner.id || id.startsWith(`${owner.id}_`);
}

/**
 * Answer `useService(mock.declaration.id)` from `mock`'s handlers inside this frame, and let
 * the handlers' `push` reach `useAppEvents(id)`. Returns the tools the handlers were given, so
 * a dev console can push by hand.
 *
 * `manifest` is the add-on's own: the declaration's id must be one the phone lets that app
 * call (its `services`, when it lists them, or else its id and `<id>_…`), and anything else
 * throws here, naming the rule, rather than working in dev and being refused in game.
 *
 * Installing a second mock for the same id replaces the first.
 */
export function installAddonMock<D extends AddonServiceDeclaration>(
  mock: AddonMockDefinition<D>,
  manifest: ServiceOwner
): AddonMockTools {
  const id = mock.declaration.id;
  if (!manifest || typeof manifest.id !== 'string' || !manifest.id) {
    throw new Error(
      `[${MICA_ADDON_MOCK_MARKER}] installAddonMock needs the add-on's manifest, to check that ` +
        `'${id}' is a service the phone lets it call.`
    );
  }
  if (!serviceAllowed(manifest, id)) {
    throw new Error(
      `[${MICA_ADDON_MOCK_MARKER}] '${manifest.id}' may not call the service '${id}': the phone ` +
        (manifest.services
          ? `allows only the ids its manifest lists in services (${manifest.services.join(', ') || 'none'}), `
          : `allows only '${manifest.id}' and ids starting '${manifest.id}_', `) +
        `and would refuse every call to it in game. Mocking it would only hide that.`
    );
  }
  if (!original) {
    // Read through the registry, so a frame that never registered a facet set fails here,
    // with the registry's own message naming the fix, rather than at the first call.
    original = { service: facets.service, appEvents: facets.appEvents };
    const base = original;
    registerFacet('service', (serviceId: string) => {
      const target = installed.get(serviceId);
      return target ? mockedService(target) : base.service(serviceId);
    });
    registerFacet('appEvents', (appId: string) => {
      const real = base.appEvents(appId);
      const target = installed.get(appId.toLowerCase());
      return target ? mockedAppEvents(target, real) : real;
    });
  }

  const declaration = mock.declaration;
  const entry: Installed = {
    id: declaration.id,
    schemas: addonActionSchemas(declaration),
    handlers: {},
    listeners: new Map(),
    buffered: []
  };
  const tools: AddonMockTools = Object.freeze({ push: pushFor(entry) });
  const handlers: unknown = mock.handlers(tools);
  if (!isPlainObject(handlers)) {
    throw new Error(
      `[${MICA_ADDON_MOCK_MARKER}] the mock for '${declaration.id}' returned no handler table.`
    );
  }
  for (const action of Object.keys(declaration.actions)) {
    if (typeof handlers[action] !== 'function') {
      console.warn(
        `[${MICA_ADDON_MOCK_MARKER}] the mock for '${declaration.id}' has no handler for ` +
          `'${action}'; calling it answers the generic failure.`
      );
    }
  }
  entry.handlers = handlers;
  installed.set(declaration.id, entry);
  console.info(
    `[${MICA_ADDON_MOCK_MARKER}] '${declaration.id}' is answered by an in-frame mock, as ` +
      `citizen ${DEV_CITIZENID}. Nothing reaches a server.`
  );
  return tools;
}

/**
 * @internal Test-only: put back the facets the first install replaced and forget every mock.
 * Not re-exported from `@mica/sdk/dev`.
 */
export function resetAddonMocksForTest(): void {
  if (original) {
    registerFacet('service', original.service);
    registerFacet('appEvents', original.appEvents);
  }
  original = undefined;
  installed.clear();
}
