// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { requestEventFor, responseEventFor, parseRequestEvent } from '@gos/shared/rpc';
import { ServiceProxy } from '../lib/ServiceProxy';

/**
 * The bug these lock down: the client used to subscribe a fixed set of four CRUD reply
 * names and required an explicit opt-in for anything else. Every custom action whose
 * author forgot — all four mail actions — timed out after 15 seconds, and `fetchNui`
 * swallowed it into a `defaultValue`, so the Mail app simply showed an empty inbox.
 */

let nuiCallbacks: Map<string, (data: any, cb: Function) => void>;
let netSubscriptions: Map<string, Function>;
let emitted: unknown[][];
let registeredNuiTypes: string[];

beforeEach(() => {
  nuiCallbacks = new Map();
  netSubscriptions = new Map();
  emitted = [];
  registeredNuiTypes = [];

  const g = globalThis as Record<string, unknown>;
  g.RegisterNuiCallbackType = (name: string) => registeredNuiTypes.push(name);
  g.on = (event: string, handler: any) => {
    nuiCallbacks.set(event.replace('__cfx_nui:', ''), handler);
  };
  g.onNet = (event: string, handler: any) => netSubscriptions.set(event, handler);
  g.emitNet = (...args: unknown[]) => emitted.push(args);
});

describe('shared/rpc — one derivation for both sides', () => {
  it.each([
    ['get', 'receive'],
    ['create', 'created'],
    ['update', 'updated'],
    ['delete', 'deleted']
  ])('maps the generic %s action to the %s reply', (action, reply) => {
    expect(responseEventFor('notes', action)).toBe(`gos:client:notes:${reply}`);
  });

  it('replies to a custom action on its own name', () => {
    expect(responseEventFor('mail', 'getMail')).toBe('gos:client:mail:getMail');
  });

  it('builds request events', () => {
    expect(requestEventFor('notes', 'get')).toBe('gos:server:notes:get');
  });

  it('round-trips a request event back to service and action', () => {
    expect(parseRequestEvent('gos:server:mail:markAsRead')).toEqual({
      service: 'mail',
      action: 'markAsRead'
    });
  });

  it.each([
    ['too few segments', 'gos:server:noServiceSegment'],
    ['wrong side', 'gos:client:notes:get'],
    ['foreign prefix', 'other:server:notes:get'],
    ['empty', '']
  ])('refuses to parse %s', (_label, event) => {
    expect(parseRequestEvent(event)).toBeNull();
  });
});

describe('ServiceProxy — subscribes the reply it will actually receive', () => {
  it('subscribes the derived reply for a generic CRUD action', () => {
    const app = new ServiceProxy('notes');
    app.registerCallback('getNotes', 'gos:server:notes:get');

    expect([...netSubscriptions.keys()]).toEqual(['gos:client:notes:receive']);
    expect(registeredNuiTypes).toEqual(['getNotes']);
  });

  it('subscribes the reply for a custom action — the mail regression', () => {
    // Every one of these used to reply into the void.
    const app = new ServiceProxy('mail');
    app.registerCallback('getMail', 'gos:server:mail:getMail');
    app.registerCallback('markAsRead', 'gos:server:mail:markAsRead');
    app.registerCallback('archiveMail', 'gos:server:mail:archiveMail');
    app.registerCallback('deleteMail', 'gos:server:mail:deleteMail');

    expect([...netSubscriptions.keys()].toSorted()).toEqual([
      'gos:client:mail:archiveMail',
      'gos:client:mail:deleteMail',
      'gos:client:mail:getMail',
      'gos:client:mail:markAsRead'
    ]);
  });

  it('subscribes a shared reply event only once', () => {
    // deleteConversation and leaveConversation both target conversations:delete.
    const subscribeSpy = vi.fn();
    (globalThis as Record<string, unknown>).onNet = (event: string, handler: any) => {
      subscribeSpy(event);
      netSubscriptions.set(event, handler);
    };

    const app = new ServiceProxy('conversations');
    app.registerCallback('deleteConversation', 'gos:server:conversations:delete');
    app.registerCallback('leaveConversation', 'gos:server:conversations:delete');

    expect(subscribeSpy).toHaveBeenCalledTimes(1);
    expect(subscribeSpy).toHaveBeenCalledWith('gos:client:conversations:deleted');
  });

  it('refuses a server event whose reply cannot be derived', () => {
    // A caller would otherwise hang for 15s. Fail at startup instead.
    const app = new ServiceProxy('phone');
    expect(() => app.registerCallback('endCall', 'gos:server:noAppSegment')).toThrow(
      /cannot be derived/
    );
  });
});

describe('ServiceProxy — request/response round trip', () => {
  it('resolves the NUI callback when the reply arrives', async () => {
    const app = new ServiceProxy('mail');
    app.registerCallback('getMail', 'gos:server:mail:getMail');

    const resolved = vi.fn();
    nuiCallbacks.get('getMail')!({}, resolved);

    // The relay emitted to the server with a correlation id...
    expect(emitted).toHaveLength(1);
    const [event, cbId] = emitted[0] as [string, string, unknown];
    expect(event).toBe('gos:server:mail:getMail');

    // ...and the derived reply resolves that same id.
    netSubscriptions.get('gos:client:mail:getMail')!(cbId, [{ id: 1, subject: 'Statement' }]);

    expect(resolved).toHaveBeenCalledWith([{ id: 1, subject: 'Statement' }]);
  });

  it('ignores a reply for an unknown correlation id', () => {
    const app = new ServiceProxy('notes');
    app.registerCallback('getNotes', 'gos:server:notes:get');

    expect(() =>
      netSubscriptions.get('gos:client:notes:receive')!('never-issued', [])
    ).not.toThrow();
  });

  it('times out a callback the server never answers', async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const app = new ServiceProxy('notes');
      app.registerCallback('getNotes', 'gos:server:notes:get');

      const resolved = vi.fn();
      nuiCallbacks.get('getNotes')!({}, resolved);
      expect(resolved).not.toHaveBeenCalled();

      vi.advanceTimersByTime(15000);
      expect(resolved).toHaveBeenCalledWith({ error: 'Request timed out' });
    } finally {
      vi.useRealTimers();
    }
  });
});
