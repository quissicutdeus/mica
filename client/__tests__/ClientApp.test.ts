import { describe, it, expect, beforeEach, vi } from 'vitest';
import { requestEventFor, responseEventFor, parseRequestEvent } from '@shared/rpc';
import { ClientApp } from '../lib/ClientApp';

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
    expect(responseEventFor('notes', action)).toBe(`gphone:client:notes:${reply}`);
  });

  it('replies to a custom action on its own name', () => {
    expect(responseEventFor('mail', 'getMail')).toBe('gphone:client:mail:getMail');
  });

  it('builds request events', () => {
    expect(requestEventFor('notes', 'get')).toBe('gphone:server:notes:get');
  });

  it('round-trips a request event back to app and action', () => {
    expect(parseRequestEvent('gphone:server:mail:markAsRead')).toEqual({
      app: 'mail',
      action: 'markAsRead'
    });
  });

  it.each([
    ['too few segments', 'gphone:server:endCall'],
    ['wrong side', 'gphone:client:notes:get'],
    ['foreign prefix', 'other:server:notes:get'],
    ['empty', '']
  ])('refuses to parse %s', (_label, event) => {
    expect(parseRequestEvent(event)).toBeNull();
  });
});

describe('ClientApp — subscribes the reply it will actually receive', () => {
  it('subscribes the derived reply for a generic CRUD action', () => {
    const app = new ClientApp('notes');
    app.registerCallback('getNotes', 'gphone:server:notes:get');

    expect([...netSubscriptions.keys()]).toEqual(['gphone:client:notes:receive']);
    expect(registeredNuiTypes).toEqual(['getNotes']);
  });

  it('subscribes the reply for a custom action — the mail regression', () => {
    // Every one of these used to reply into the void.
    const app = new ClientApp('mail');
    app.registerCallback('getMail', 'gphone:server:mail:getMail');
    app.registerCallback('markAsRead', 'gphone:server:mail:markAsRead');
    app.registerCallback('archiveMail', 'gphone:server:mail:archiveMail');
    app.registerCallback('deleteMail', 'gphone:server:mail:deleteMail');

    expect([...netSubscriptions.keys()].sort()).toEqual([
      'gphone:client:mail:archiveMail',
      'gphone:client:mail:deleteMail',
      'gphone:client:mail:getMail',
      'gphone:client:mail:markAsRead'
    ]);
  });

  it('subscribes a shared reply event only once', () => {
    // deleteConversation and leaveConversation both target conversations:delete.
    const subscribeSpy = vi.fn();
    (globalThis as Record<string, unknown>).onNet = (event: string, handler: any) => {
      subscribeSpy(event);
      netSubscriptions.set(event, handler);
    };

    const app = new ClientApp('conversations');
    app.registerCallback('deleteConversation', 'gphone:server:conversations:delete');
    app.registerCallback('leaveConversation', 'gphone:server:conversations:delete');

    expect(subscribeSpy).toHaveBeenCalledTimes(1);
    expect(subscribeSpy).toHaveBeenCalledWith('gphone:client:conversations:deleted');
  });

  it('refuses a server event whose reply cannot be derived', () => {
    // A caller would otherwise hang for 15s. Fail at startup instead.
    const app = new ClientApp('phone');
    expect(() => app.registerCallback('endCall', 'gphone:server:endCall')).toThrow(
      /cannot be derived/
    );
  });
});

describe('ClientApp — request/response round trip', () => {
  it('resolves the NUI callback when the reply arrives', async () => {
    const app = new ClientApp('mail');
    app.registerCallback('getMail', 'gphone:server:mail:getMail');

    const resolved = vi.fn();
    nuiCallbacks.get('getMail')!({}, resolved);

    // The relay emitted to the server with a correlation id...
    expect(emitted).toHaveLength(1);
    const [event, cbId] = emitted[0] as [string, string, unknown];
    expect(event).toBe('gphone:server:mail:getMail');

    // ...and the derived reply resolves that same id.
    netSubscriptions.get('gphone:client:mail:getMail')!(cbId, [{ id: 1, subject: 'Statement' }]);

    expect(resolved).toHaveBeenCalledWith([{ id: 1, subject: 'Statement' }]);
  });

  it('ignores a reply for an unknown correlation id', () => {
    const app = new ClientApp('notes');
    app.registerCallback('getNotes', 'gphone:server:notes:get');

    expect(() =>
      netSubscriptions.get('gphone:client:notes:receive')!('never-issued', [])
    ).not.toThrow();
  });

  it('times out a callback the server never answers', async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const app = new ClientApp('notes');
      app.registerCallback('getNotes', 'gphone:server:notes:get');

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
