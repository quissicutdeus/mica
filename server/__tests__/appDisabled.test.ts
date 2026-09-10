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
import { defineContract, responseType } from '@mica/shared/contract';
import { s } from '@mica/shared/schema';

/**
 * An app the owner switched off is refused at the server boundary (MICA-234).
 *
 * The shell hiding a tile is not a control: a registered net event is reachable whether or
 * not a tile points at it (§2.9). So the refusal sits where the rate limiter does, and these
 * cases drive a real `ServiceEndpoint` rather than the lookup table alone — a custom action,
 * generic CRUD, a service owned under another name, and the scopes that are never refused.
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

/** A service with one custom action, `ping`, whose handler is the returned spy. */
const mountCustom = (service: string) => {
  const handler = vi.fn(async () => ({ pong: true }));
  const contract = contracts.get(service) ?? pingContract(service);
  contracts.set(service, contract);
  const app = new ServiceEndpoint<never, typeof contract>(service, null, {
    contract,
    disableGet: true,
    disableCreate: true,
    disableUpdate: true,
    disableDelete: true
  });
  app.registerEvent('ping', handler);
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
    const handler = mountCustom('mail');
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
      disableCreate: true,
      disableUpdate: true,
      disableDelete: true
    });
    disable('notes');

    expect(await call('notes', 'get', {})).toMatchObject({ key: 'server.endpoint.appDisabled' });
    expect(dbMock.query).not.toHaveBeenCalled();
  });

  it('refuses a service its app owns under another name', async () => {
    const handler = mountCustom('blabber_dms');
    disable('blabber');

    expect(await call('blabber_dms', 'ping')).toMatchObject({ params: { app: 'blabber' } });
    expect(handler).not.toHaveBeenCalled();
  });

  it('leaves an app the list does not name untouched', async () => {
    const handler = mountCustom('mail');
    disable('notes,hodlr');

    expect(await call('mail', 'ping')).toEqual({ pong: true });
    expect(handler).toHaveBeenCalledOnce();
  });

  it('never refuses a non-app scope or a shared service, even when the list names it', async () => {
    const scopes = ['shell', 'admin', 'phone', 'battery', 'signal', 'reports', 'contacts', 'bank'];
    const spies = scopes.map((service) => [service, mountCustom(service)] as const);
    disable(scopes.join(','));

    for (const [service, handler] of spies) {
      expect(await call(service, 'ping'), service).toEqual({ pong: true });
      expect(handler, service).toHaveBeenCalledOnce();
    }
  });

  it('applies a change to the convar on the next request, without a restart', async () => {
    mountCustom('mail');

    expect(await call('mail', 'ping')).toEqual({ pong: true });
    disable('mail');
    expect(await call('mail', 'ping')).toMatchObject({ key: 'server.endpoint.appDisabled' });
    disable('');
    expect(await call('mail', 'ping')).toEqual({ pong: true });
  });
});

describe('a disabled app, at a raw net event', () => {
  it("drops a disabled app's event silently, and passes a never-refused one", () => {
    disable('mail,contacts');

    expect(guardNetEvent('mail', 'anything', noInput, [])).toBeNull();
    expect(guardNetEvent('contacts', 'share', noInput, [])).not.toBeNull();
  });
});
