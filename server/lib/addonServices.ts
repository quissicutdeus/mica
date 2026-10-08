// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  ADDON_ERROR_MESSAGE_MAX,
  addonActionSchemas,
  checkAddonService,
  type AddonServiceDeclaration
} from '@mica/shared/addonService';
import { APP_EVENT_NAME_PATTERN, type AppEventNotification } from '@mica/shared/appEvents';
import type { ServiceContract } from '@mica/shared/contract';
import type { StandardSchemaV1 } from '@mica/shared/schema';
import { appEventChannel, MAX_PAYLOAD_BYTES } from './appEvents';
import { GENERIC_ERROR_MESSAGE, PlayerFacingError } from './errors';
import { fail, ok, type ExportOutcome } from './exports';
import { HANDLER_TIMEOUT_MS } from './numberRegistry';
import { appDisabledError, isAppDisabled } from './ownerConfig';
import { onResourceReleased } from './resourceStop';
import { ServiceEndpoint } from './ServiceEndpoint';
import { knownServices, serviceApps } from './services';

/**
 * Add-on services served from another resource (MICA-308).
 *
 * A Store add-on reaches `mica:server:<id>:<action>` through the generic `svc` door
 * (`shared/rpc.ts`), and until this existed only a `ServiceEndpoint` declared inside micaOS
 * answered it. Now the add-on's own resource calls `RegisterService(declaration, handlers)`
 * and micaOS answers for it — through a **real `ServiceEndpoint`**, so every call passes the
 * same guard a core service's does, in the same order (`ServiceEndpoint.bind`): the rate
 * limiter, the owner's app switch, the player lookup, the declared input parsed, and only then
 * the handler, with a `PlayerFacingError` or `SchemaError` the only text a player reads. There
 * is no second guard here to drift from the first.
 *
 * Two things are different from a core service, and both live in this file:
 *
 * - **Registrations come and go; net handlers do not.** FiveM cannot cleanly remove an `onNet`
 *   handler, so each `(id, action)` is bound exactly once per process, and every call looks up
 *   the registration that is current *now*. Its input is parsed against that registration's
 *   schema and the parsed value carries the registration it was checked against, so a
 *   re-registration between the parse and the handler can never hand one schema's output to
 *   another's handler.
 * - **The handler is somebody else's code.** It is a function ref into another resource and
 *   may throw, reject, hang, answer something that is not JSON, or belong to a resource that
 *   stopped mid-call. Every one of those answers the player micaOS's generic failure — never a
 *   stuck call — and is logged with the resource's name.
 *
 * micaOS stores nothing for an add-on. Its tables are its own, and whether the citizen a call
 * arrives with may touch the row its input names is the add-on's check to write: `citizenid`
 * is the only identity micaOS vouches for.
 */

type AddonHandlerRef = (citizenid: string, input: unknown, source: number) => unknown;

interface Registration {
  readonly id: string;
  readonly owner: string;
  readonly declaration: AddonServiceDeclaration;
  readonly schemas: Readonly<Record<string, StandardSchemaV1<unknown, unknown>>>;
  readonly handlers: Readonly<Record<string, AddonHandlerRef>>;
  /**
   * One resolver per call in flight, each removed when its call settles. Release settles them
   * all at once. Per call rather than one long-lived promise every call races against: a race
   * leaves a reaction on that promise for as long as it is pending, and each reaction keeps its
   * call's answer alive until the resource stops (MICA-308 review: 55 MB over 200k calls).
   */
  readonly inFlight: Set<() => void>;
  released: boolean;
}

/** What a released call settles with; distinct from anything a handler could answer. */
const RELEASED = Symbol('released');
const TIMED_OUT = Symbol('timed out');

/**
 * What a call's input parses to: the registration it was checked against, and the value; or
 * nothing to call, with the app the owner switched off when that is why.
 */
type Parsed = { reg: Registration; input: unknown } | { reg: null; disabled?: string };

/**
 * The largest answer passed on to a player. Far above a push's 16 KB, because an answer is the
 * list a screen shows; still bounded, because it is one net event to one client.
 */
export const ADDON_ANSWER_MAX_BYTES = 262_144;

/**
 * How many distinct add-on ids one process will bind. Each costs a net handler per action
 * that can never be removed, so a script registering ids in a loop must hit a wall.
 */
export const ADDON_SERVICES_MAX = 128;

/**
 * How many distinct ids one resource may bind per server start, so one looping resource cannot
 * take all `ADDON_SERVICES_MAX`. An add-on's resource serves its own id and a few `<id>_…`
 * siblings; sixteen is generous for that and still leaves room for seven other resources.
 */
export const ADDON_SERVICES_PER_RESOURCE = 16;

/**
 * How many `(id, action)` pairs one process will bind. Each is an `onNet` handler that cannot
 * be removed, and re-registering one id with fresh action names would otherwise bind forever.
 * 4096 is 64 ids at the format's full 64 actions each, or every one of the 128 ids at 32 —
 * far past any real server — while keeping the worst case a few thousand closures.
 */
export const ADDON_ACTIONS_BOUND_MAX = 4096;

/** The most citizens one `PushToApp` fans out to. */
export const PUSH_TARGETS_MAX = 256;

/** `mica_notifications` widths a persisted toast must fit (`kind` defaults to the event). */
const EVENT_MAX = 32;
const NOTIFY_TITLE_MAX = 80;
const NOTIFY_MESSAGE_MAX = 255;
const NOTIFY_AVATAR_MAX = 255;
const NOTIFY_TYPES = ['success', 'error', 'info', 'warning'] as const;

/**
 * App ids that ship with micaOS (`core: true`), whether or not they have a server service.
 *
 * `knownServices()` covers every app with one; this covers the rest — Calculator, Camera — so
 * an add-on can never answer for, or push to, a built-in app. `addonServices.test.ts` holds
 * this list to the `core: true` manifests on disk, so a new built-in app fails a test until it
 * is listed. `core: false` apps that ship in-tree are not named here (`sdk/coreBoundary.test.ts`
 * forbids it); those with a service are covered by `knownServices()`.
 */
export const BUILT_IN_APP_IDS: readonly string[] = [
  'admin',
  'bank',
  'calculator',
  'camera',
  'contacts',
  'jobs',
  'mail',
  'marketplace',
  'media',
  'messages',
  'music',
  'phone',
  'places',
  'settings',
  'store'
];

const registrations = new Map<string, Registration>();

/** Every id ever bound, with its endpoint's mutable contract and the actions bound on it. */
const endpoints = new Map<
  string,
  { contract: ServiceContract; bound: Set<string>; endpoint: ServiceEndpoint<never> }
>();

/**
 * Every id an add-on's endpoint has registered in `lib/services.ts`. Kept apart from `endpoints`
 * because that registry cannot forget an id, so neither can this — not even `__resetAddonBindings`.
 */
const addonIds = new Set<string>();

/** How many `(id, action)` pairs are bound, across every id. */
let boundActions = 0;

/** The distinct ids each resource has bound this server start, for its own cap. */
const idsBoundBy = new Map<string, Set<string>>();

/** Test seam: forget registrations. Bound endpoints stay, as they do in a running server. */
export const __resetAddonRegistrations = (): void => {
  for (const reg of registrations.values()) releaseRegistration(reg);
};

/**
 * Test seam: also forget what was bound, so a cap test counts from zero. Not something a
 * running server can do — its `onNet` handlers stay — which is why it is a separate seam.
 */
export const __resetAddonBindings = (): void => {
  __resetAddonRegistrations();
  endpoints.clear();
  idsBoundBy.clear();
  boundActions = 0;
};

/** Test seam: calls in flight on `id`'s registration, which must fall back to 0 once settled. */
export const __addonCallsInFlight = (id: string): number =>
  registrations.get(id)?.inFlight.size ?? 0;

/** The registration answering for `id` now, if any. */
export const addonRegistration = (id: string): { owner: string; actions: string[] } | undefined => {
  const reg = registrations.get(id);
  return reg ? { owner: reg.owner, actions: Object.keys(reg.declaration.actions) } : undefined;
};

/** Whether `id` belongs to micaOS: a core service, a core service's app, or a built-in app. */
const isCoreId = (id: string): boolean => {
  // An id this file bound is in `knownServices()` too — the endpoint registered it — and it is
  // still the add-on's.
  if (addonIds.has(id)) return false;
  if (knownServices().includes(id)) return true;
  for (const app of serviceApps().values()) if (app === id) return true;
  return BUILT_IN_APP_IDS.includes(id);
};

/**
 * The app the owner switched off that `id` falls under, or null.
 *
 * The id itself, or any prefix of it ending at an `_`: `mica_disabled_apps journal` switches
 * off `journal` and `journal_extra` alike, the same namespace rule an add-on's services follow
 * (`id === app || id.startsWith(app + '_')`). Shortest first, so the answer names the app the
 * owner most likely listed.
 */
export const disabledAddonApp = (id: string): string | null => {
  for (let at = id.indexOf('_'); at !== -1; at = id.indexOf('_', at + 1)) {
    const prefix = id.slice(0, at);
    if (prefix && isAppDisabled(prefix)) return prefix;
  }
  return isAppDisabled(id) ? id : null;
};

/**
 * The generic failure, as `ServiceEndpoint` answers an unexpected throw — same text, same key.
 * Thrown as a `PlayerFacingError` so the endpoint passes it through without logging it again:
 * the cause has already been logged here, once, with the add-on's name on it.
 */
const genericFailure = (): PlayerFacingError =>
  // The key written out rather than `GENERIC_ERROR_KEY`, so `serverMessages.test.ts` can see it.
  new PlayerFacingError(GENERIC_ERROR_MESSAGE, { key: 'server.generic' });

const logFailure = (reg: Registration, action: string, what: string, error?: unknown): void => {
  const where = `[mica] add-on service ${reg.id}:${action} (${reg.owner})`;
  if (error === undefined) console.error(`${where} ${what}`);
  else console.error(`${where} ${what}:`, error);
};

/**
 * The input validator the endpoint is given for one `(id, action)`: delegates to whichever
 * registration is current at the moment of the call.
 *
 * With nothing registered it passes the call through as `{ reg: null }` rather than refusing
 * it, so an unregistered id answers the generic failure and not a schema message about a
 * field — the same answer whether the service never existed here or its resource stopped.
 */
const currentInput = (id: string, action: string): StandardSchemaV1<unknown, Parsed> => ({
  '~standard': {
    version: 1,
    vendor: 'mica',
    validate: (value: unknown) => {
      // The endpoint refuses the id itself before the player lookup; a prefix of it the owner
      // switched off (`disabledAddonApp`) is refused here, before anything is parsed.
      const disabled = disabledAddonApp(id);
      if (disabled) return { value: { reg: null, disabled } };
      const reg = registrations.get(id);
      const schema = reg?.schemas[action];
      if (!reg || !schema) return { value: { reg: null } };
      const outcome = schema['~standard'].validate(value);
      // Every schema here is built by `addonActionSchemas` from `s`, which is synchronous.
      if (outcome instanceof Promise)
        return { issues: [{ message: 'That value could not be checked.' }] };
      if (outcome.issues) return { issues: outcome.issues };
      return { value: { reg, input: outcome.value } };
    }
  }
});

/**
 * What the player receives for a handler's answer, or a throw.
 *
 * `{ error: { message } }` is a refusal for the player: its message, whitespace collapsed and
 * cut to `ADDON_ERROR_MESSAGE_MAX`, reaches the toast. No message key is passed on — a key is
 * looked up in micaOS's own catalog, which an add-on cannot add to, and would let it speak in
 * one of micaOS's messages. Any other `error` property is a malformed refusal and answers
 * generically, so a stray `{ error: <anything> }` can never reach the client verbatim.
 *
 * Everything else must be JSON and at most `ADDON_ANSWER_MAX_BYTES`, and is sent as its JSON
 * round trip: a function ref, `undefined` or a class instance inside an answer is dropped rather
 * than sent on to the client. `undefined` itself answers `null`, so the caller is never left
 * waiting on a reply that will not come.
 */
const answerFor = (reg: Registration, action: string, answer: unknown): unknown => {
  if (answer !== null && typeof answer === 'object' && Object.hasOwn(answer, 'error')) {
    const message = (answer as { error?: { message?: unknown } }).error?.message;
    if (typeof message === 'string') {
      const text = message.replace(/\s+/g, ' ').trim();
      if (text) {
        // Keyless by nature: the add-on's own words, in whatever language it wrote them, and
        // nothing in micaOS's catalog could translate them (`serverMessages.test.ts` counts it).
        throw new PlayerFacingError(
          text.length > ADDON_ERROR_MESSAGE_MAX
            ? `${text.slice(0, ADDON_ERROR_MESSAGE_MAX - 1)}…`
            : text
        );
      }
    }
    logFailure(reg, action, "answered an 'error' that is not { message = '…' }");
    throw genericFailure();
  }

  let json: string | undefined;
  try {
    json = JSON.stringify(answer === undefined ? null : answer);
  } catch (error) {
    logFailure(reg, action, 'answered something that is not JSON', error);
    throw genericFailure();
  }
  if (json === undefined) {
    logFailure(reg, action, 'answered a function or a symbol');
    throw genericFailure();
  }
  if (json.length > ADDON_ANSWER_MAX_BYTES) {
    logFailure(reg, action, `answered ${json.length} bytes, over ${ADDON_ANSWER_MAX_BYTES}`);
    throw genericFailure();
  }
  return JSON.parse(json) as unknown;
};

/**
 * Call the handler, and settle within `HANDLER_TIMEOUT_MS` whatever it does.
 *
 * `askLine`'s pattern (`numberRegistry.ts`), with one more way out: the registration's
 * `released`, so a call in flight when its resource stops answers at once instead of waiting
 * out the timeout on a function ref into a resource that no longer exists.
 */
const invoke = async (
  reg: Registration,
  action: string,
  citizenid: string,
  input: unknown,
  source: number
): Promise<unknown> => {
  const handler = reg.handlers[action];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settle: (() => void) | undefined;
  let answer: unknown;
  try {
    answer = await Promise.race([
      // A synchronous throw becomes a rejection here rather than escaping the race.
      new Promise<unknown>((resolve) => resolve(handler(citizenid, input, source))),
      new Promise<typeof RELEASED>((resolve) => {
        settle = () => resolve(RELEASED);
        if (reg.released) settle();
        else reg.inFlight.add(settle);
      }),
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), HANDLER_TIMEOUT_MS);
      })
    ]);
  } catch (error) {
    logFailure(reg, action, 'threw', error);
    throw genericFailure();
  } finally {
    if (timer) clearTimeout(timer);
    if (settle) reg.inFlight.delete(settle);
  }

  if (answer === TIMED_OUT) {
    logFailure(reg, action, `did not answer within ${HANDLER_TIMEOUT_MS}ms`);
    throw genericFailure();
  }
  // Released, or replaced by a newer registration, while the handler ran: the answer belongs
  // to a service that is no longer the one this id names.
  if (answer === RELEASED || registrations.get(reg.id) !== reg) throw genericFailure();
  return answerFor(reg, action, answer);
};

/** Bind `(id, action)` once per process. Later registrations reuse it. */
const bind = (id: string, action: string): void => {
  let entry = endpoints.get(id);
  if (!entry) {
    const contract: ServiceContract = { id, actions: {} };
    const endpoint = new ServiceEndpoint<never>(id, null, {
      contract,
      // The add-on's app id, so an owner who switches the app off with `mica_disabled_apps`
      // turns its server half off too — the same refusal a core app gets (MICA-234).
      app: id,
      // Both devices (MICA-264): a `core: false` add-on may list the tablet, which has a Store
      // to install it from. Its rows are per citizen — micaOS hands the handler a citizenid and
      // never a device id — so the tablet reads what the phone does. The endpoint is bound once
      // per process while registrations come and go, so a per-registration list could not
      // change it; the device check still refuses a tablet the player does not hold.
      devices: ['phone', 'tablet'],
      disableGet: true,
      disableCreate: true,
      disableUpdate: true,
      disableDelete: true
    });
    entry = { contract, bound: new Set(), endpoint };
    addonIds.add(id);
    endpoints.set(id, entry);
  }
  if (entry.bound.has(action)) return;
  boundActions += 1;

  (entry.contract.actions as Record<string, { input: StandardSchemaV1 }>)[action] = {
    input: currentInput(id, action)
  };
  entry.endpoint.registerEvent(action, async (source, _cbId, data, citizenid) => {
    const parsed = data as Parsed;
    if (!parsed.reg && parsed.disabled) throw appDisabledError(parsed.disabled);
    // Nothing answers for this id now, or the registration that parsed the input has gone.
    if (!parsed.reg || registrations.get(id) !== parsed.reg) throw genericFailure();
    return invoke(parsed.reg, action, citizenid, parsed.input, source);
  });
  entry.bound.add(action);
};

function releaseRegistration(reg: Registration): void {
  if (registrations.get(reg.id) === reg) registrations.delete(reg.id);
  reg.released = true;
  for (const settle of reg.inFlight) settle();
  reg.inFlight.clear();
}

const newRegistration = (
  declaration: AddonServiceDeclaration,
  handlers: Record<string, AddonHandlerRef>,
  owner: string
): Registration => ({
  id: declaration.id,
  owner,
  declaration,
  schemas: addonActionSchemas(declaration),
  handlers,
  inFlight: new Set(),
  released: false
});

/**
 * Hold an id for `owner` and answer its actions with `rawHandlers`.
 *
 * Refused with `invalid_args` and the reason for a declaration that is not one, or handlers
 * that do not match it one for one; `already_registered` when another resource holds the id.
 * A core id is `invalid_args`: no resource can ever hold one, so it is not a conflict that
 * waiting resolves. The same owner registering again replaces its registration, and calls in
 * flight on the old one answer the generic failure.
 */
export function registerAddonService(
  rawDeclaration: unknown,
  rawHandlers: unknown,
  owner: unknown
): ExportOutcome {
  if (typeof owner !== 'string' || owner.length === 0) {
    return fail('invalid_args', 'RegisterService must be called from another resource.');
  }

  const checked = checkAddonService(rawDeclaration);
  if (!checked.ok) return fail('invalid_args', checked.reason);
  const declaration = checked.value;
  const id = declaration.id;

  if (isCoreId(id)) {
    return fail('invalid_args', `'${id}' belongs to micaOS and cannot be registered.`);
  }

  // A Lua empty table crosses as [], and means {}: it then fails below for the action it lacks,
  // which says more than "not a table". A non-empty list is still refused.
  const handlerMap =
    Array.isArray(rawHandlers) && rawHandlers.length === 0 ? {} : (rawHandlers as unknown);
  if (handlerMap === null || typeof handlerMap !== 'object' || Array.isArray(handlerMap)) {
    return fail('invalid_args', 'handlers must be a table of action name to function.');
  }
  const handlers: Record<string, AddonHandlerRef> = {};
  for (const action of Object.keys(declaration.actions)) {
    const handler = (handlerMap as Record<string, unknown>)[action];
    if (!Object.hasOwn(handlerMap, action) || typeof handler !== 'function') {
      return fail('invalid_args', `Action '${action}' has no handler function.`);
    }
    handlers[action] = handler as AddonHandlerRef;
  }
  for (const action of Object.keys(handlerMap)) {
    if (!Object.hasOwn(declaration.actions, action)) {
      return fail('invalid_args', `Handler '${action}' has no declared action.`);
    }
  }

  const held = registrations.get(id);
  if (held && held.owner !== owner) {
    return fail('already_registered', `${held.owner} already holds the service '${id}'.`);
  }
  // The caps, all checked before anything is bound, so a refusal binds nothing.
  const mine = idsBoundBy.get(owner) ?? new Set<string>();
  if (!endpoints.has(id) && endpoints.size >= ADDON_SERVICES_MAX) {
    return fail(
      'invalid_args',
      `micaOS serves at most ${ADDON_SERVICES_MAX} add-on service ids per server start.`
    );
  }
  if (!mine.has(id) && mine.size >= ADDON_SERVICES_PER_RESOURCE) {
    return fail(
      'invalid_args',
      `A resource may register at most ${ADDON_SERVICES_PER_RESOURCE} service ids per server start.`
    );
  }
  const bound = endpoints.get(id)?.bound;
  const fresh = Object.keys(declaration.actions).filter((action) => !bound?.has(action)).length;
  if (boundActions + fresh > ADDON_ACTIONS_BOUND_MAX) {
    return fail(
      'invalid_args',
      `micaOS binds at most ${ADDON_ACTIONS_BOUND_MAX} add-on actions per server start; ` +
        `this declaration would add ${fresh} to the ${boundActions} already bound.`
    );
  }
  mine.add(id);
  idsBoundBy.set(owner, mine);

  for (const action of Object.keys(declaration.actions)) bind(id, action);
  if (held) releaseRegistration(held);
  registrations.set(id, newRegistration(declaration, handlers, owner));
  return ok();
}

/** Release `id`, if `owner` holds it. */
export function unregisterAddonService(rawId: unknown, owner: unknown): ExportOutcome {
  if (typeof rawId !== 'string') return fail('invalid_args', 'A service id is required.');
  const held = registrations.get(rawId);
  if (!held) return fail('invalid_args', 'Nothing holds that service id.');
  if (held.owner !== owner) {
    return fail('not_owner', 'That service belongs to another resource.');
  }
  releaseRegistration(held);
  return ok();
}

/** Release everything `owner` holds, and return the ids. */
export function releaseAddonServices(owner: string): string[] {
  const dropped = [...registrations.values()].filter((reg) => reg.owner === owner);
  for (const reg of dropped) releaseRegistration(reg);
  return dropped.map((reg) => reg.id);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const boundedText = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length <= max;

/** A toast request from another resource, checked to fit the row it may be persisted as. */
const notifyFrom = (raw: unknown): AppEventNotification | string => {
  if (!isRecord(raw)) return 'notify must be a table with a message.';
  for (const key of Object.keys(raw)) {
    if (!['type', 'title', 'message', 'avatar'].includes(key)) {
      return `'${key}' is not a notify option.`;
    }
  }
  const { type, title, message, avatar } = raw;
  if (!boundedText(message, NOTIFY_MESSAGE_MAX) || !message.trim()) {
    return `notify.message must be text of 1 to ${NOTIFY_MESSAGE_MAX} characters.`;
  }
  if (title !== undefined && title !== null && !boundedText(title, NOTIFY_TITLE_MAX)) {
    return `notify.title must be text of at most ${NOTIFY_TITLE_MAX} characters.`;
  }
  if (type !== undefined && type !== null && !(NOTIFY_TYPES as readonly unknown[]).includes(type)) {
    return `notify.type must be one of ${NOTIFY_TYPES.join(', ')}.`;
  }
  if (
    avatar !== undefined &&
    avatar !== null &&
    !(boundedText(avatar, NOTIFY_AVATAR_MAX) && /^https:\/\//i.test(avatar))
  ) {
    return `notify.avatar must be an https URL of at most ${NOTIFY_AVATAR_MAX} characters.`;
  }
  return {
    message,
    ...(typeof title === 'string' ? { title } : {}),
    ...(typeof type === 'string' ? { type: type as AppEventNotification['type'] } : {}),
    ...(typeof avatar === 'string' ? { avatar } : {})
  };
};

/**
 * Push to the add-on's app, as a built-in service pushes to its own: `appEventChannel(id)`,
 * received by `useAppEvents(id)` on each online citizen's phone. At most once, never queued.
 *
 * Only for an id `owner` holds — `not_owner` otherwise, whether another resource holds it or
 * nobody does: a resource may speak only as its own app. `notify`, when given, is the toast
 * the shell raises if the app declared `notifications`, and is persisted to the shade like any
 * other app's.
 */
export function pushToAddonApp(
  rawId: unknown,
  rawTargets: unknown,
  rawEvent: unknown,
  rawPayload: unknown,
  rawNotify: unknown,
  owner: unknown
): ExportOutcome<{ delivered: string[]; offline: string[] }> {
  type Out = { delivered: string[]; offline: string[] };
  if (typeof rawId !== 'string' || registrations.get(rawId)?.owner !== owner) {
    return fail<Out>('not_owner', 'Push only to a service id your resource has registered.');
  }
  const id = rawId;
  const disabled = disabledAddonApp(id);
  if (disabled) {
    return fail<Out>('app_disabled', `The owner has turned '${disabled}' off on this server.`);
  }

  const targets = typeof rawTargets === 'string' ? [rawTargets] : rawTargets;
  if (
    !Array.isArray(targets) ||
    targets.length === 0 ||
    !targets.every((target) => typeof target === 'string' && target.trim().length > 0)
  ) {
    return fail<Out>('invalid_args', 'A citizenid, or a list of them, is required.');
  }
  const citizenids = [...new Set(targets as string[])];
  if (citizenids.length > PUSH_TARGETS_MAX) {
    return fail<Out>('invalid_args', `At most ${PUSH_TARGETS_MAX} citizens per push.`);
  }

  if (
    typeof rawEvent !== 'string' ||
    !APP_EVENT_NAME_PATTERN.test(rawEvent) ||
    rawEvent.length > EVENT_MAX
  ) {
    return fail<Out>(
      'invalid_args',
      `An event name is lower_snake_case, at most ${EVENT_MAX} characters.`
    );
  }

  let payload: Record<string, unknown> = {};
  if (rawPayload !== undefined && rawPayload !== null) {
    // A Lua empty table crosses as [], and means {}.
    const map = Array.isArray(rawPayload) && rawPayload.length === 0 ? {} : rawPayload;
    if (!isRecord(map)) return fail<Out>('invalid_args', 'payload must be a table.');
    let json: string;
    try {
      json = JSON.stringify(map);
    } catch {
      return fail<Out>('invalid_args', 'payload must be JSON.');
    }
    if (json.length > MAX_PAYLOAD_BYTES) {
      return fail<Out>(
        'invalid_args',
        `payload is over ${MAX_PAYLOAD_BYTES} bytes. A push carries a reference, not a document.`
      );
    }
    // The round trip drops a function ref or anything else that is not data before it is sent.
    payload = JSON.parse(json) as Record<string, unknown>;
  }

  let notify: AppEventNotification | undefined;
  if (rawNotify !== undefined && rawNotify !== null) {
    const checked = notifyFrom(rawNotify);
    if (typeof checked === 'string') return fail<Out>('invalid_args', checked);
    notify = checked;
  }

  const outcome = appEventChannel(id).pushMany(citizenids, rawEvent, payload, { notify });
  return ok<Out>(outcome);
}

// Through `onResourceReleased`: a forged `onResourceStop` naming a running resource must not
// free its ids for the forger to register and read every player's input.
onResourceReleased((resource) => {
  const dropped = releaseAddonServices(resource);
  if (dropped.length > 0) {
    console.log(`[mica] released add-on service(s) ${dropped.join(', ')} held by ${resource}.`);
  }
});
