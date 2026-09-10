// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { dbMock, bridgeMock } = vi.hoisted(() => ({
  dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() },
  bridgeMock: { getPlayer: vi.fn() }
}));
vi.mock('../lib/Database', () => ({ Database: dbMock }));
vi.mock('../lib/FrameworkBridge', () => ({ FrameworkBridge: bridgeMock }));

import { Repository } from '../lib/Repository';
import { ServiceEndpoint } from '../lib/ServiceEndpoint';
import { guardNetEvent, noInput } from '../lib/netGuard';
import { __resetRateLimits } from '../lib/rateLimit';
import { __resetOwnerConfig } from '../lib/ownerConfig';
import { registerService } from '../lib/services';
import { defineContract, responseType } from '@mica/shared/contract';
import { s } from '@mica/shared/schema';

/**
 * An app the owner switched off is refused at the server boundary (MICA-234).
 *
 * The shell hiding a tile is not a control: a registered net event is reachable whether or
 * not a tile points at it (§2.9). So the refusal sits where the rate limiter does, and these
 * cases drive a real `ServiceEndpoint` rather than the lookup alone — a custom action, generic
 * CRUD, a service owned under another name, the scopes that are never refused, and one real
 * declaration end to end. What is refused is what the service itself declares with `app`.
 */

type Handler = (cbId: string, data: unknown) => Promise<void>;

let handlers: Map<string, Handler>;
let emitted: unknown[][];

class TestRepo extends Repository<{ id: number }> {
  protected tableName = 'mica_test';
  protected columns = ['id', 'citizenid', 'title', 'status', 'created_at', 'updated_at'];
  protected clientWritable = ['title'];
  protected clientFilterable = ['title'];
}

const disable = (list: string) => {
  (globalThis as any).GetConvar = (name: string, fallback: string) =>
    name === 'mica_disabled_apps' ? list : fallback;
};

beforeEach(() => {
  vi.clearAllMocks();
  __resetRateLimits();
  __resetOwnerConfig();
  handlers = new Map();
  emitted = [];
  (globalThis as any).onNet = (event: string, cb: Handler) => handlers.set(event, cb);
  (globalThis as any).emitNet = (...args: unknown[]) => emitted.push(args);
  (globalThis as any).source = 5;
  bridgeMock.getPlayer.mockReturnValue({ citizenid: 'CIT_A', source: 5, setMeta: vi.fn() });
  dbMock.query.mockResolvedValue([]);
  disable('');
});

/** A contract is registered once per service id per process, so each is built once here. */
const contracts = new Map<string, ReturnType<typeof pingContract>>();
const pingContract = (service: string) =>
  defineContract({
    id: service,
    actions: { ping: { input: s.none(), output: responseType<{ pong: boolean }>() } }
  });

/**
 * A service with one custom action, `ping`, whose handler is the returned spy. `app` is the
 * declaration under test: absent, the service is shared and never refused.
 */
const mountCustom = (service: string, app?: string) => {
  const handler = vi.fn(async () => ({ pong: true }));
  const contract = contracts.get(service) ?? pingContract(service);
  contracts.set(service, contract);
  const endpoint = new ServiceEndpoint<never, typeof contract>(service, null, {
    ...(app ? { app } : {}),
    contract,
    disableGet: true,
    disableCreate: true,
    disableUpdate: true,
    disableDelete: true
  });
  endpoint.registerEvent('ping', handler);
  return handler;
};

const call = async (service: string, action: string, data?: unknown) => {
  const handler = handlers.get(`mica:server:${service}:${action}`);
  if (!handler) throw new Error(`no handler for ${service}:${action}`);
  await handler('cb-1', data);
  return emitted.at(-1)?.[3] as Record<string, unknown>;
};

describe('a disabled app, at the ServiceEndpoint boundary', () => {
  it("refuses the app's custom action before the handler or the player lookup runs", async () => {
    const handler = mountCustom('mail', 'mail');
    disable('mail');

    expect(await call('mail', 'ping')).toEqual({
      error: 'The mail app is turned off on this server.',
      key: 'server.endpoint.appDisabled',
      params: { app: 'mail' }
    });
    expect(handler).not.toHaveBeenCalled();
    expect(bridgeMock.getPlayer).not.toHaveBeenCalled();
  });

  it('refuses generic CRUD too, before anything reaches SQL', async () => {
    new ServiceEndpoint('notes', new TestRepo(), {
      app: 'notes',
      disableCreate: true,
      disableUpdate: true,
      disableDelete: true
    });
    disable('notes');

    expect(await call('notes', 'get', {})).toMatchObject({ key: 'server.endpoint.appDisabled' });
    expect(dbMock.query).not.toHaveBeenCalled();
  });

  it('refuses a service its app owns under another name', async () => {
    const handler = mountCustom('blabber_dms', 'blabber');
    disable('blabber');

    expect(await call('blabber_dms', 'ping')).toMatchObject({ params: { app: 'blabber' } });
    expect(handler).not.toHaveBeenCalled();
  });

  it('leaves an app the list does not name untouched', async () => {
    const handler = mountCustom('mail', 'mail');
    disable('notes,hodlr');

    expect(await call('mail', 'ping')).toEqual({ pong: true });
    expect(handler).toHaveBeenCalledOnce();
  });

  it('never refuses a service that declares no app, even when the list names it', async () => {
    const scopes = ['shell', 'admin', 'phone', 'battery', 'signal', 'reports', 'contacts', 'bank'];
    const spies = scopes.map((service) => [service, mountCustom(service)] as const);
    disable(scopes.join(','));

    for (const [service, handler] of spies) {
      expect(await call(service, 'ping'), service).toEqual({ pong: true });
      expect(handler, service).toHaveBeenCalledOnce();
    }
  });

  it('applies a change to the convar on the next request, without a restart', async () => {
    mountCustom('mail', 'mail');

    expect(await call('mail', 'ping')).toEqual({ pong: true });
    disable('mail');
    expect(await call('mail', 'ping')).toMatchObject({ key: 'server.endpoint.appDisabled' });
    disable('');
    expect(await call('mail', 'ping')).toEqual({ pong: true });
  });
});

describe("Snek's board, through its real declaration", () => {
  it('refuses a score while snek is off, before SQL, and takes it again once it is back', async () => {
    // Imported here, after `onNet` points at this case's map, so its handlers land in it.
    await import('../services/Highscores');
    disable('snek');

    expect(await call('highscores', 'submit', { app: 'snek', score: 10 })).toEqual({
      error: 'The snek app is turned off on this server.',
      key: 'server.endpoint.appDisabled',
      params: { app: 'snek' }
    });
    expect(await call('highscores', 'top', { app: 'snek' })).toMatchObject({
      key: 'server.endpoint.appDisabled'
    });
    expect(bridgeMock.getPlayer).not.toHaveBeenCalled();
    expect(dbMock.query).not.toHaveBeenCalled();
    expect(dbMock.insert).not.toHaveBeenCalled();

    disable('');
    expect(await call('highscores', 'submit', { app: 'snek', score: 10 })).toEqual({ ok: true });
  });
});

describe('a disabled app, at a raw net event', () => {
  it("drops a disabled app's event silently, and passes a never-refused one", () => {
    registerService('mail', 'mail');
    disable('mail,contacts');

    expect(guardNetEvent('mail', 'anything', noInput, [])).toBeNull();
    expect(guardNetEvent('contacts', 'share', noInput, [])).not.toBeNull();
  });
});
