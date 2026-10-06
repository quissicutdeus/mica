// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * An add-on's server half from another resource (MICA-308): `RegisterService`,
 * `UnregisterService` and `PushToApp`, and the dispatch behind them.
 *
 * The dispatch is driven through the real `onNet` handler a `ServiceEndpoint` registers, so the
 * guard order under test is the core one — limiter, app switch, player, parse, handler — and
 * not a copy of it. The FiveM globals are captured before any import, because the module
 * registers its `onResourceStop` listener at import time.
 */

type NetHandler = (cbId: string, data: unknown) => Promise<void>;

const fivem = vi.hoisted(() => {
  const state = {
    net: new Map<string, (cbId: string, data: unknown) => Promise<void>>(),
    local: new Map<string, ((...args: unknown[]) => void)[]>(),
    emitted: [] as unknown[][]
  };
  const g = globalThis as Record<string, unknown>;
  g.onNet = (event: string, cb: (cbId: string, data: unknown) => Promise<void>) => {
    state.net.set(event, cb);
  };
  g.on = (event: string, cb: (...args: unknown[]) => void) => {
    state.local.set(event, [...(state.local.get(event) ?? []), cb]);
  };
  g.emitNet = (...args: unknown[]) => {
    state.emitted.push(args);
  };
  g.source = 5;
  return state;
});

const { dbMock, bridgeMock, disabled, persisted } = vi.hoisted(() => ({
  dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() },
  bridgeMock: {
    getPlayer: vi.fn(),
    getAllPlayers: vi.fn(() => ({})),
    getSourcesByCitizenId: vi.fn((_ids: readonly string[]) => new Map<string, number>()),
    getSourceByCitizenId: vi.fn(() => null),
    getPlayerByPhone: vi.fn(() => undefined),
    getPlayerPhone: vi.fn(),
    findOfflineByCitizenId: vi.fn(async () => null),
    findOfflineByPhone: vi.fn(async () => null),
    registerUsableItem: vi.fn(),
    countItem: vi.fn(() => 0)
  },
  disabled: new Set<string>(),
  persisted: vi.fn(async (_rows: unknown[]) => {})
}));

vi.mock('../lib/Database', () => ({ Database: dbMock }));
vi.mock('../lib/FrameworkBridge', () => ({
  FrameworkBridge: bridgeMock,
  detectFramework: () => 'qb'
}));
// Both halves of the owner's app switch read this set: `disabledAppFor` (the endpoint's guard)
// and `isAppDisabled` (the push). Mocked together because one calls the other internally.
vi.mock('../lib/ownerConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/ownerConfig')>()),
  isAppDisabled: (app: string) => disabled.has(app),
  disabledAppFor: (service: string) => (disabled.has(service) ? service : null)
}));
vi.mock('../services/Notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/Notifications')>()),
  getNotificationsRepository: () => ({ createNotificationBatch: persisted })
}));

import { registerPublicApi } from '../lib/publicApi';
import { publishedExport, publishedExports } from '../lib/exports';
import {
  ADDON_ACTIONS_BOUND_MAX,
  ADDON_ANSWER_MAX_BYTES,
  ADDON_SERVICES_MAX,
  ADDON_SERVICES_PER_RESOURCE,
  BUILT_IN_APP_IDS,
  __addonCallsInFlight,
  __resetAddonBindings,
  addonRegistration
} from '../lib/addonServices';
import {
  HANDLER_TIMEOUT_MS,
  __resetRegistry,
  lookupLine,
  registerNumber
} from '../lib/numberRegistry';
import { isGenuineStop } from '../lib/resourceStop';
import { GENERIC_ERROR_KEY, GENERIC_ERROR_MESSAGE } from '../lib/errors';
import { __resetRateLimits } from '../lib/rateLimit';
import { APP_EVENT_NET_EVENT } from '@mica/shared/appEvents';
import { responseEventFor } from '@mica/shared/rpc';
import { callAsResource } from './invokingResource';

const CID = 'CIT_ADDON';
const SRC = 5;
const RESOURCE = 'journal-server';

const journal = {
  id: 'journal',
  actions: {
    create: {
      input: {
        title: { type: 'string', min: 1, max: 10 },
        body: { type: 'string', max: 20, optional: true }
      }
    },
    list: { input: {} }
  }
};

const exported = (name: string) => publishedExport(name) as (...args: unknown[]) => any;

/** Call an export as `resource`, with `GetInvokingResource` live only on the stack. */
const as = (resource: string, name: string, ...args: unknown[]) =>
  callAsResource(resource, () => exported(name)(...args));

const register = (handlers: Record<string, unknown>, decl: unknown = journal, by = RESOURCE) =>
  as(by, 'RegisterService', decl, handlers);

/** Drive `mica:server:<id>:<action>` the way the client relay emits it, and return the reply. */
const call = async (action: string, data: unknown, id = 'journal') => {
  const handler = fivem.net.get(`mica:server:${id}:${action}`) as NetHandler | undefined;
  if (!handler) throw new Error(`nothing listens on mica:server:${id}:${action}`);
  const before = fivem.emitted.length;
  await handler('cb-1', data);
  const replies = fivem.emitted.slice(before);
  expect(replies).toHaveLength(1);
  const [event, target, cbId, body] = replies[0];
  expect(event).toBe(responseEventFor(id, action));
  expect(target).toBe(SRC);
  expect(cbId).toBe('cb-1');
  return body as any;
};

const GENERIC = { error: GENERIC_ERROR_MESSAGE, key: GENERIC_ERROR_KEY, params: undefined };

/**
 * Fire `onResourceStop` naming `resource`, with `GetResourceState` answering `state` for it —
 * `'stopping'` is what FiveM says during a real stop, `'started'` is a forged event naming a
 * resource that is still running.
 */
const fireStop = (resource: string, state: string) => {
  const host = globalThis as { GetResourceState?: (name: string) => string };
  host.GetResourceState = (name) => (name === resource ? state : 'started');
  try {
    for (const listener of fivem.local.get('onResourceStop') ?? []) listener(resource);
  } finally {
    delete host.GetResourceState;
  }
};

const stopResource = (resource: string) => fireStop(resource, 'stopping');

let errors: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  fivem.emitted.length = 0;
  disabled.clear();
  // Every test counts from nothing bound, so the caps below are exact rather than whatever the
  // tests before them happened to leave.
  __resetAddonBindings();
  __resetRateLimits();
  bridgeMock.getPlayer.mockReturnValue({ citizenid: CID, source: SRC });
  bridgeMock.getSourcesByCitizenId.mockImplementation(() => new Map<string, number>());
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  errors.mockRestore();
});

registerPublicApi();

describe('the exports', () => {
  it('are published', () => {
    expect(publishedExports()).toEqual(
      expect.arrayContaining(['RegisterService', 'UnregisterService', 'PushToApp'])
    );
  });

  it('attribute a registration to the invoking resource, read before anything yields', async () => {
    expect(await register({ create: vi.fn(), list: vi.fn() })).toEqual({ ok: true });
    expect(addonRegistration('journal')).toEqual({ owner: RESOURCE, actions: ['create', 'list'] });
  });

  it('refuses a call with no invoking resource', async () => {
    const outcome = await callAsResource('', () =>
      exported('RegisterService')(journal, { create: vi.fn(), list: vi.fn() })
    );
    expect(outcome).toMatchObject({ ok: false, reason: 'invalid_args' });
  });

  it('refuses a declaration that is not one, with the reason', async () => {
    const outcome = await register({ a: vi.fn() }, { id: 'journal', actions: { a: {} } });
    expect(outcome).toEqual({
      ok: false,
      reason: 'invalid_args',
      message: "actions.a declares no 'input'. Use {} for an action that takes nothing."
    });
  });

  it('refuses handlers that do not match the actions one for one', async () => {
    expect(await register({ create: vi.fn() })).toMatchObject({
      reason: 'invalid_args',
      message: "Action 'list' has no handler function."
    });
    expect(await register({ create: vi.fn(), list: 'not a function' })).toMatchObject({
      reason: 'invalid_args',
      message: "Action 'list' has no handler function."
    });
    expect(await register({ create: vi.fn(), list: vi.fn(), remove: vi.fn() })).toMatchObject({
      reason: 'invalid_args',
      message: "Handler 'remove' has no declared action."
    });
    // A Lua empty table crosses as []: read as {}, so the refusal names the missing action.
    expect(await register([] as never)).toMatchObject({
      reason: 'invalid_args',
      message: "Action 'create' has no handler function."
    });
    expect(await register([vi.fn(), vi.fn()] as never)).toMatchObject({
      reason: 'invalid_args',
      message: 'handlers must be a table of action name to function.'
    });
    expect(addonRegistration('journal')).toBeUndefined();
  });

  it('takes a Lua empty table, which crosses as [], wherever the format expects a map', async () => {
    const list = vi.fn(() => []);
    const lua = { id: 'journal', actions: { create: { input: [] }, list: { input: [] } } };
    expect(await register({ create: vi.fn(), list }, lua)).toEqual({ ok: true });
    // An empty table answered from Lua is `[]` ("no rows"), and goes back as one.
    expect(await call('list', undefined)).toEqual([]);
    expect(list).toHaveBeenCalledWith(CID, {}, SRC);
    expect(
      await register({ list }, { id: 'journal', actions: { list: { input: [1] } } })
    ).toMatchObject({ reason: 'invalid_args' });
    expect(await register({}, { id: 'journal', actions: [] })).toMatchObject({
      reason: 'invalid_args',
      message: "'actions' must name at least one action."
    });
  });

  it('refuses a core service id, a core app id and a built-in app id', async () => {
    for (const id of ['contacts', 'mail', 'shell', 'calculator', 'camera', 'settings']) {
      const outcome = await register({ list: vi.fn() }, { id, actions: { list: { input: {} } } });
      expect(outcome, id).toEqual({
        ok: false,
        reason: 'invalid_args',
        message: `'${id}' belongs to micaOS and cannot be registered.`
      });
    }
  });

  it("refuses an id another resource holds, and replaces the owner's own", async () => {
    const first = vi.fn(() => 'first');
    const second = vi.fn(() => 'second');
    await register({ create: vi.fn(), list: first });
    expect(await register({ create: vi.fn(), list: vi.fn() }, journal, 'rival')).toEqual({
      ok: false,
      reason: 'already_registered',
      message: `${RESOURCE} already holds the service 'journal'.`
    });
    expect(await call('list', {})).toBe('first');

    expect(await register({ create: vi.fn(), list: second })).toEqual({ ok: true });
    expect(await call('list', {})).toBe('second');
    expect(first).toHaveBeenCalledTimes(1);
  });

  it('releases everything a resource holds when it stops, and only that', async () => {
    await register({ create: vi.fn(), list: vi.fn(() => []) });
    await register(
      { list: vi.fn(() => []) },
      { id: 'diary', actions: { list: { input: {} } } },
      'other'
    );
    stopResource(RESOURCE);
    expect(addonRegistration('journal')).toBeUndefined();
    expect(addonRegistration('diary')).toEqual({ owner: 'other', actions: ['list'] });
    expect(await call('list', {})).toEqual(GENERIC);
    // Free for anyone now.
    expect(await register({ create: vi.fn(), list: vi.fn() }, journal, 'rival')).toEqual({
      ok: true
    });
  });

  it('unregisters for the owner only', async () => {
    await register({ create: vi.fn(), list: vi.fn() });
    expect(await as('rival', 'UnregisterService', 'journal')).toEqual({
      ok: false,
      reason: 'not_owner',
      message: 'That service belongs to another resource.'
    });
    expect(addonRegistration('journal')?.owner).toBe(RESOURCE);
    expect(await as(RESOURCE, 'UnregisterService', 'journal')).toEqual({ ok: true });
    expect(addonRegistration('journal')).toBeUndefined();
    expect(await as(RESOURCE, 'UnregisterService', 'journal')).toMatchObject({
      reason: 'invalid_args'
    });
    expect(await as(RESOURCE, 'UnregisterService', 7)).toMatchObject({ reason: 'invalid_args' });
  });
});

describe('dispatch through the core guard', () => {
  it('parses the input before the handler runs, and the handler never sees a refusal', async () => {
    const create = vi.fn();
    await register({ create, list: vi.fn() });
    expect(await call('create', { title: 'x'.repeat(11) })).toEqual({
      error: 'title must be 10 characters or fewer.',
      key: undefined,
      params: undefined
    });
    expect(await call('create', { title: 'ok', citizenid: 'SOMEONE_ELSE' })).toMatchObject({
      error: 'citizenid is not a field this request accepts.'
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('hands the handler (citizenid, parsed input, source) and nothing else', async () => {
    const create = vi.fn(() => ({ id: 1 }));
    await register({ create, list: vi.fn() });
    expect(await call('create', { title: 'hello', body: 'there' })).toEqual({ id: 1 });
    expect(create).toHaveBeenCalledWith(CID, { title: 'hello', body: 'there' }, SRC);
    // An action taking nothing gets {} for a call that sent nothing.
    const list = vi.fn(() => []);
    await register({ create, list });
    await call('list', undefined);
    expect(list).toHaveBeenCalledWith(CID, {}, SRC);
  });

  it('answers a synchronous and an asynchronous handler alike', async () => {
    await register({ create: () => ({ id: 2 }), list: async () => [{ id: 3 }] });
    expect(await call('create', { title: 'a' })).toEqual({ id: 2 });
    expect(await call('list', {})).toEqual([{ id: 3 }]);
  });

  it('answers the generic failure for a throw and a rejection, and logs the resource', async () => {
    await register({
      create: () => {
        throw new Error('db down: SELECT * FROM journal_secret');
      },
      list: async () => {
        throw new Error('nope');
      }
    });
    expect(await call('create', { title: 'a' })).toEqual(GENERIC);
    expect(await call('list', {})).toEqual(GENERIC);
    expect(String(errors.mock.calls[0][0])).toContain(`journal:create (${RESOURCE}) threw`);
  });

  it('answers the generic failure when the handler outlives HANDLER_TIMEOUT_MS', async () => {
    vi.useFakeTimers();
    await register({ create: vi.fn(), list: () => new Promise(() => {}) });
    let reply: unknown;
    const pending = call('list', {}).then((body) => (reply = body));
    await vi.advanceTimersByTimeAsync(HANDLER_TIMEOUT_MS - 1);
    expect(reply).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(reply).toEqual(GENERIC);
  });

  it('answers at once, generically, a call in flight when its resource stops', async () => {
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    await register({
      create: vi.fn(),
      list: () => {
        started();
        return new Promise(() => {});
      }
    });
    const pending = call('list', {});
    await running;
    stopResource(RESOURCE);
    expect(await pending).toEqual(GENERIC);
  });

  it('passes `{ error: { message } }` to the player as a refusal, trimmed and capped', async () => {
    await register({
      create: () => ({ error: { message: '  That   title is taken.  ', key: 'server.generic' } }),
      list: () => ({ error: { message: 'x'.repeat(500) } })
    });
    expect(await call('create', { title: 'a' })).toEqual({
      error: 'That title is taken.',
      key: undefined,
      params: undefined
    });
    const capped = await call('list', {});
    expect(capped.error).toHaveLength(160);
    expect(capped.error.endsWith('…')).toBe(true);
  });

  it('answers generically for an error that is not { message }, so it never passes verbatim', async () => {
    await register({ create: () => ({ error: 'raw <b>html</b>' }), list: () => ({ error: {} }) });
    expect(await call('create', { title: 'a' })).toEqual(GENERIC);
    expect(await call('list', {})).toEqual(GENERIC);
  });

  it('answers generically for an answer that is not JSON, or too large', async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await register({ create: () => cyclic, list: () => 10n });
    expect(await call('create', { title: 'a' })).toEqual(GENERIC);
    expect(await call('list', {})).toEqual(GENERIC);

    await register({ create: () => () => 1, list: () => 'x'.repeat(ADDON_ANSWER_MAX_BYTES) });
    expect(await call('create', { title: 'a' })).toEqual(GENERIC);
    expect(await call('list', {})).toEqual(GENERIC);
  });

  it('sends the JSON of an answer: functions dropped, undefined as null', async () => {
    await register({ create: () => ({ id: 1, ref: () => 1 }), list: () => undefined });
    expect(await call('create', { title: 'a' })).toEqual({ id: 1 });
    expect(await call('list', {})).toBeNull();
  });

  it('answers the generic failure for an action of an unregistered service', async () => {
    const list = vi.fn();
    await register({ create: vi.fn(), list });
    await as(RESOURCE, 'UnregisterService', 'journal');
    expect(await call('list', {})).toEqual(GENERIC);
    // A payload a registration would refuse still gets the same answer: nothing to parse against.
    expect(await call('create', { nonsense: true })).toEqual(GENERIC);
    expect(list).not.toHaveBeenCalled();
    // And an id never registered has no listener at all, exactly as an unknown core service.
    expect(fivem.net.has('mica:server:never_registered:list')).toBe(false);
  });

  it('re-registration reuses the bound handler and applies the new schema', async () => {
    await register({ create: vi.fn(() => 'old'), list: vi.fn() });
    const handler = fivem.net.get('mica:server:journal:create');
    await register(
      { create: vi.fn(() => 'new') },
      { id: 'journal', actions: { create: { input: { n: { type: 'integer', max: 3 } } } } }
    );
    expect(fivem.net.get('mica:server:journal:create')).toBe(handler);
    expect(await call('create', { n: 2 })).toBe('new');
    expect(await call('create', { title: 'a' })).toMatchObject({
      error: 'title is not a field this request accepts.'
    });
    // An action the new declaration dropped answers as unregistered.
    expect(await call('list', {})).toEqual(GENERIC);
  });

  it('applies the per-source rate limiter before the handler', async () => {
    const list = vi.fn(() => []);
    await register({ create: vi.fn(), list });
    for (let index = 0; index < 60; index++) await call('list', {});
    expect(await call('list', {})).toEqual({
      error: 'Too many journal list requests. Slow down and try again.',
      key: 'server.rateLimited'
    });
    expect(list).toHaveBeenCalledTimes(60);
  });

  it('refuses a caller with no character before parsing or calling', async () => {
    const create = vi.fn();
    await register({ create, list: vi.fn() });
    bridgeMock.getPlayer.mockReturnValue(undefined);
    expect(await call('create', { title: 'a' })).toEqual({
      error: 'Player not authenticated',
      key: 'server.notAuthenticated'
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("is refused when the owner switched the add-on's app off", async () => {
    const list = vi.fn();
    await register({ create: vi.fn(), list });
    disabled.add('journal');
    expect(await call('list', {})).toMatchObject({ key: 'server.endpoint.appDisabled' });
    expect(list).not.toHaveBeenCalled();
  });

  it('holds no per-call listener once calls settle', async () => {
    let finish!: (value: unknown) => void;
    await register({
      create: vi.fn(() => ({ id: 1 })),
      list: () => new Promise((resolve) => (finish = resolve))
    });
    for (let index = 0; index < 50; index++) await call('create', { title: 'a' });
    expect(__addonCallsInFlight('journal')).toBe(0);
    // One in flight is counted, so the zero above is a count and not a constant.
    const pending = call('list', {});
    await vi.waitFor(() => expect(__addonCallsInFlight('journal')).toBe(1));
    finish([]);
    expect(await pending).toEqual([]);
    expect(__addonCallsInFlight('journal')).toBe(0);
  });

  it('switches off an id under a disabled app prefix, on an _ boundary only', async () => {
    const decl = (id: string) => ({ id, actions: { list: { input: {} } } });
    const extra = vi.fn(() => []);
    const lookalike = vi.fn(() => []);
    await register({ list: extra }, decl('journal_extra'));
    await register({ list: lookalike }, decl('journalx'));
    disabled.add('journal');
    expect(await call('list', {}, 'journal_extra')).toEqual({
      error: 'The journal app is turned off on this server.',
      key: 'server.endpoint.appDisabled',
      params: { app: 'journal' }
    });
    expect(extra).not.toHaveBeenCalled();
    expect(await call('list', {}, 'journalx')).toEqual([]);
  });

  it(`lets one resource bind ${ADDON_SERVICES_PER_RESOURCE} ids, and not one more`, async () => {
    const decl = (id: string) => ({ id, actions: { a: { input: {} } } });
    for (let index = 0; index < ADDON_SERVICES_PER_RESOURCE - 1; index++) {
      expect(await register({ a: vi.fn() }, decl(`loop_${index}`), 'looping')).toEqual({
        ok: true
      });
    }
    const lastAllowed = `loop_${ADDON_SERVICES_PER_RESOURCE - 1}`;
    expect(await register({ a: vi.fn() }, decl(lastAllowed), 'looping')).toEqual({ ok: true });
    expect(await register({ a: vi.fn() }, decl('loop_over'), 'looping')).toEqual({
      ok: false,
      reason: 'invalid_args',
      message: `A resource may register at most ${ADDON_SERVICES_PER_RESOURCE} service ids per server start.`
    });
    // Re-registering one it already bound is not a new id, and another resource is unaffected.
    expect(await register({ a: vi.fn() }, decl(lastAllowed), 'looping')).toEqual({ ok: true });
    expect(await register({ a: vi.fn() }, decl('loop_over'), 'other')).toEqual({ ok: true });
  });

  it(`binds ${ADDON_SERVICES_MAX} distinct ids per process, and not one more`, async () => {
    const decl = (id: string) => ({ id, actions: { a: { input: {} } } });
    for (let index = 0; index < ADDON_SERVICES_MAX - 1; index++) {
      const by = `res_${Math.floor(index / ADDON_SERVICES_PER_RESOURCE)}`;
      expect(await register({ a: vi.fn() }, decl(`bulk_${index}`), by)).toEqual({ ok: true });
    }
    expect(await register({ a: vi.fn() }, decl('bulk_last'), 'fresh_a')).toEqual({ ok: true });
    expect(await register({ a: vi.fn() }, decl('bulk_over'), 'fresh_b')).toEqual({
      ok: false,
      reason: 'invalid_args',
      message: `micaOS serves at most ${ADDON_SERVICES_MAX} add-on service ids per server start.`
    });
  });

  it(`binds ${ADDON_ACTIONS_BOUND_MAX} (id, action) pairs per process, and not one more`, async () => {
    const PER_ID = 64;
    const decl = (id: string, names: string[]) => ({
      id,
      actions: Object.fromEntries(names.map((name) => [name, { input: {} }]))
    });
    const handlersFor = (names: string[]) =>
      Object.fromEntries(names.map((name) => [name, vi.fn()]));
    const names = Array.from({ length: PER_ID }, (_, index) => `a${index}`);
    const ids = ADDON_ACTIONS_BOUND_MAX / PER_ID;
    for (let index = 0; index < ids; index++) {
      const by = `res_${Math.floor(index / ADDON_SERVICES_PER_RESOURCE)}`;
      expect(await register(handlersFor(names), decl(`pairs_${index}`, names), by)).toEqual({
        ok: true
      });
    }
    // Exactly at the cap now. Re-registering with actions already bound adds nothing and is fine;
    // one fresh action name is the pair over the cap.
    expect(await register(handlersFor(['a0']), decl('pairs_0', ['a0']), 'res_0')).toEqual({
      ok: true
    });
    expect(await register(handlersFor(['fresh']), decl('pairs_0', ['fresh']), 'res_0')).toEqual({
      ok: false,
      reason: 'invalid_args',
      message:
        `micaOS binds at most ${ADDON_ACTIONS_BOUND_MAX} add-on actions per server start; ` +
        `this declaration would add 1 to the ${ADDON_ACTIONS_BOUND_MAX} already bound.`
    });
    expect(fivem.net.has('mica:server:pairs_0:fresh')).toBe(false);
  });
});

describe('PushToApp', () => {
  const push = (by: string, ...args: unknown[]) => as(by, 'PushToApp', ...args);

  beforeEach(async () => {
    await register({ create: vi.fn(), list: vi.fn() });
  });

  it('pushes through appEventChannel(id) to each online citizen', async () => {
    bridgeMock.getSourcesByCitizenId.mockImplementation(() => new Map([[CID, SRC]]));
    expect(await push(RESOURCE, 'journal', [CID, 'GONE', CID], 'entry_added', { id: 4 })).toEqual({
      ok: true,
      value: { delivered: [CID], offline: ['GONE'] }
    });
    const sent = fivem.emitted.filter(([event]) => event === APP_EVENT_NET_EVENT);
    expect(sent).toHaveLength(1);
    expect(sent[0][1]).toBe(SRC);
    expect(sent[0][2]).toMatchObject({ app: 'journal', event: 'entry_added', payload: { id: 4 } });
    expect(persisted).not.toHaveBeenCalled();
  });

  it('is refused for an id the calling resource does not hold', async () => {
    expect(await push('rival', 'journal', CID, 'entry_added', {})).toEqual({
      ok: false,
      reason: 'not_owner',
      message: 'Push only to a service id your resource has registered.'
    });
    expect(await push(RESOURCE, 'nobody_holds', CID, 'x', {})).toMatchObject({
      reason: 'not_owner'
    });
    expect(await push(RESOURCE, 'messages', CID, 'x', {})).toMatchObject({ reason: 'not_owner' });
    expect(fivem.emitted).toHaveLength(0);
  });

  it('refuses a bad event name, target, payload or notify', async () => {
    const refused = async (...args: unknown[]) =>
      expect(await push(RESOURCE, 'journal', ...args)).toMatchObject({ reason: 'invalid_args' });
    await refused(CID, 'Entry-Added', {});
    await refused(CID, 'x'.repeat(33), {});
    await refused(CID, 7, {});
    await refused([], 'x', {});
    await refused([CID, 4], 'x', {});
    await refused('  ', 'x', {});
    await refused(CID, 'x', 'payload');
    await refused(CID, 'x', [1]);
    await refused(CID, 'x', { blob: 'x'.repeat(20_000) });
    await refused(CID, 'x', {}, { title: 'no message' });
    await refused(CID, 'x', {}, { message: 'm', deepLink: 'mail' });
    await refused(CID, 'x', {}, { message: 'm', avatar: 'http://insecure.example/a.png' });
    await refused(CID, 'x', {}, { message: 'x'.repeat(256) });
    await refused(CID, 'x', {}, { message: 'm', type: 'loud' });
    await refused(
      Array.from({ length: 257 }, (_, index) => `C${index}`),
      'x',
      {}
    );
    expect(fivem.emitted).toHaveLength(0);
  });

  it('persists a notify to the shade, under the add-on id', async () => {
    expect(
      await push(RESOURCE, 'journal', CID, 'entry_added', [], { message: 'New entry', title: 'J' })
    ).toEqual({ ok: true, value: { delivered: [], offline: [CID] } });
    expect(persisted).toHaveBeenCalledWith([
      expect.objectContaining({ citizenid: CID, app: 'journal', title: 'J', body: 'New entry' })
    ]);
  });

  it('is refused for an app the owner switched off', async () => {
    disabled.add('journal');
    expect(await push(RESOURCE, 'journal', CID, 'x', {})).toMatchObject({
      reason: 'app_disabled'
    });
  });

  it('never throws into the caller', async () => {
    bridgeMock.getSourcesByCitizenId.mockImplementation(() => {
      throw new Error('framework exploded');
    });
    expect(await push(RESOURCE, 'journal', CID, 'x', {})).toMatchObject({
      ok: false,
      reason: 'internal_error'
    });
  });
});

describe('a forged onResourceStop (MICA-308 review)', () => {
  it('is told apart from a real stop by GetResourceState', () => {
    const host = globalThis as { GetResourceState?: (name: string) => string };
    const state = (value: string) => (host.GetResourceState = () => value);
    try {
      state('started');
      expect(isGenuineStop('victim')).toBe(false);
      state('starting');
      expect(isGenuineStop('victim')).toBe(false);
      state('stopping');
      expect(isGenuineStop('victim')).toBe(true);
      state('stopped');
      expect(isGenuineStop('victim')).toBe(true);
      expect(isGenuineStop('')).toBe(false);
      expect(isGenuineStop(7)).toBe(false);
    } finally {
      delete host.GetResourceState;
    }
  });

  it("does not release a running resource's service for another to take", async () => {
    await register({ create: vi.fn(), list: vi.fn(() => 'victim') });
    fireStop(RESOURCE, 'started');
    expect(addonRegistration('journal')?.owner).toBe(RESOURCE);
    expect(await register({ create: vi.fn(), list: vi.fn() }, journal, 'thief')).toMatchObject({
      reason: 'already_registered'
    });
    expect(await call('list', {})).toBe('victim');
    // The real stop still releases it.
    fireStop(RESOURCE, 'stopping');
    expect(addonRegistration('journal')).toBeUndefined();
  });

  it("does not release a running resource's number, micaOS's own job lines included", () => {
    __resetRegistry();
    const onCall = () => ({ action: 'reject' });
    expect(registerNumber('5550101', { onCall }, 'dispatch')).toMatchObject({ ok: true });
    expect(registerNumber('5550911', { onCall }, 'mica')).toMatchObject({ ok: true });
    fireStop('dispatch', 'started');
    fireStop('mica', 'started');
    expect(lookupLine('5550101')?.owner).toBe('dispatch');
    expect(lookupLine('5550911')?.owner).toBe('mica');
    fireStop('dispatch', 'stopping');
    expect(lookupLine('5550101')).toBeUndefined();
    __resetRegistry();
  });
});

describe('BUILT_IN_APP_IDS', () => {
  it('is exactly the core: true apps on disk', () => {
    const apps = join(__dirname, '..', '..', 'web', 'src', 'apps');
    const core = readdirSync(apps)
      .filter((id) => statSync(join(apps, id)).isDirectory())
      .filter((id) => /core:\s*true/.test(readFileSync(join(apps, id, 'manifest.ts'), 'utf8')))
      .sort();
    expect(core.length).toBeGreaterThan(5);
    expect([...BUILT_IN_APP_IDS].sort()).toEqual(core);
  });
});
