import { describe, it, expect, vi } from 'vitest';
import { get } from 'svelte/store';
import { remoteCall, remoteStore, remoteFn, encodeArgs } from './remote';
import { AppPermissionError } from '../protocol';
import type { ToShell } from './messages';
import { fakeTransport } from './__fixtures__/fakeTransport';

describe('remoteCall', () => {
  it('sends a call and resolves with the reply value', async () => {
    const f = fakeTransport();
    const p = remoteCall('contacts', [], 'addContact', 'A', '555');
    const msg = f.sent[0] as Extract<ToShell, { kind: 'call' }>;
    expect(msg).toMatchObject({
      kind: 'call',
      facet: 'contacts',
      member: 'addContact',
      args: ['A', '555']
    });
    f.replies.get(msg.id)!({ kind: 'reply', id: msg.id, ok: true, value: { id: 7 } });
    await expect(p).resolves.toEqual({ id: 7 });
  });

  it('rethrows a permission refusal as AppPermissionError', async () => {
    const f = fakeTransport();
    const p = remoteCall('contacts', [], 'addContact');
    const { id } = f.sent[0] as Extract<ToShell, { kind: 'call' }>;
    f.replies.get(id)!({
      kind: 'reply',
      id,
      ok: false,
      error: {
        name: 'AppPermissionError',
        message: 'denied',
        permission: 'contacts',
        hookName: 'useContacts'
      }
    });
    await expect(p).rejects.toBeInstanceOf(AppPermissionError);
  });

  it('encodes function args as callback refs and fires them on callback messages', () => {
    const f = fakeTransport();
    const handler = vi.fn();
    const [enc] = encodeArgs([handler]);
    expect(enc).toEqual({ __cb: 1 });
    f.callbacks.get(1)!('x');
    expect(handler).toHaveBeenCalledWith('x');
  });
});

describe('remoteStore', () => {
  it('starts at initial, subscribes lazily, and follows pushes', () => {
    const f = fakeTransport();
    const s = remoteStore<number>('notifications', ['blabber'], 'unreadCount', 0);
    expect(f.sent).toHaveLength(0);
    const unsub = s.subscribe(() => {});
    const sub = f.sent[0] as Extract<ToShell, { kind: 'subscribe' }>;
    expect(sub).toMatchObject({
      kind: 'subscribe',
      facet: 'notifications',
      factoryArgs: ['blabber'],
      member: 'unreadCount'
    });
    expect(get(s)).toBe(0);
    f.pushes.get(sub.id)!(3);
    expect(get(s)).toBe(3);
    unsub();
    expect(f.sent[f.sent.length - 1]).toEqual({ kind: 'unsubscribe', id: sub.id });
  });
});

describe('remoteFn', () => {
  it('invokes the handle', () => {
    const f = fakeTransport();
    remoteFn({ __fn: 9 })('a');
    expect(f.sent[0]).toEqual({ kind: 'invoke', handle: 9, args: ['a'] });
  });
});
