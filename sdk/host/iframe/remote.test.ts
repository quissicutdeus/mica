// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

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

describe('remoteStore wire sharing', () => {
  type Sub = Extract<ToShell, { kind: 'subscribe' }>;
  const subs = (sent: ToShell[]) => sent.filter((m): m is Sub => m.kind === 'subscribe');
  const unsubs = (sent: ToShell[]) => sent.filter((m) => m.kind === 'unsubscribe');

  // Two `useStreamerMode()` calls, as two `MediaThumb`s make them: two stores, one key.
  it('sends one subscribe for two readers of the same key, and fans pushes out to both', () => {
    const f = fakeTransport();
    const a = remoteStore<boolean>('streamer', [], 'enabled', false);
    const b = remoteStore<boolean>('streamer', [], 'enabled', false);
    const seenA: boolean[] = [];
    const seenB: boolean[] = [];
    const offA = a.subscribe((v) => seenA.push(v));
    const offB = b.subscribe((v) => seenB.push(v));

    expect(subs(f.sent)).toHaveLength(1);
    const { id } = subs(f.sent)[0];
    f.pushes.get(id)!(true);
    expect(seenA).toEqual([false, true]);
    expect(seenB).toEqual([false, true]);

    offA();
    expect(unsubs(f.sent)).toHaveLength(0);
    f.pushes.get(id)!(false);
    expect(seenB).toEqual([false, true, false]);

    offB();
    expect(unsubs(f.sent)).toEqual([{ kind: 'unsubscribe', id }]);
  });

  it('opens a fresh wire id once the last reader has left', () => {
    const f = fakeTransport();
    const s = remoteStore('streamer', [], 'enabled', false);
    s.subscribe(() => {})();
    s.subscribe(() => {})();
    const [first, second] = subs(f.sent);
    expect(second.id).not.toBe(first.id);
    expect(unsubs(f.sent)).toEqual([
      { kind: 'unsubscribe', id: first.id },
      { kind: 'unsubscribe', id: second.id }
    ]);
  });

  it('starts a late reader from the latest push, and an early one from its own seed', () => {
    const f = fakeTransport();
    const early = remoteStore('clock', [], 'formattedTime', 'seed-a');
    const sibling = remoteStore('clock', [], 'formattedTime', 'seed-b');
    const offEarly = early.subscribe(() => {});
    // Joined before any push: its own seed, not the first caller's.
    expect(get(sibling)).toBe('seed-b');
    f.pushes.get(subs(f.sent)[0].id)!('12:00');
    const late = remoteStore('clock', [], 'formattedTime', 'seed-c');
    expect(get(late)).toBe('12:00');
    expect(subs(f.sent)).toHaveLength(1);
    offEarly();
  });

  it('keeps different factoryArgs and different members on separate wires', () => {
    const f = fakeTransport();
    const offs = [
      remoteStore('notifications', ['blabber'], 'unreadCount', 0),
      remoteStore('notifications', ['bank'], 'unreadCount', 0),
      remoteStore('notifications', ['blabber'], 'total', 0),
      remoteStore('notifications', [{ app: 'blabber' }], 'unreadCount', 0),
      remoteStore('notifications', [{ app: 'bank' }], 'unreadCount', 0),
      remoteStore('notifications', [null], 'unreadCount', 0),
      remoteStore('notifications', [undefined], 'unreadCount', 0),
      remoteStore('notifications', ['1'], 'unreadCount', 0),
      remoteStore('notifications', [1], 'unreadCount', 0)
    ].map((s) => s.subscribe(() => {}));
    expect(subs(f.sent)).toHaveLength(offs.length);
    expect(new Set(subs(f.sent).map((m) => m.id)).size).toBe(offs.length);
    // Equal-by-value args from separate literals still share.
    remoteStore('notifications', [{ app: 'bank' }], 'unreadCount', 0).subscribe(() => {});
    expect(subs(f.sent)).toHaveLength(offs.length);
    for (const off of offs) off();
  });

  it('never throws on an arg it cannot encode, and gives it a wire of its own', () => {
    const f = fakeTransport();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const throwing = {
      get boom(): never {
        throw new Error('getter');
      }
    };
    const odd: unknown[][] = [
      [() => {}],
      [() => {}],
      [cyclic],
      [cyclic],
      [throwing],
      [new Date(0)]
    ];
    const offs = odd.map((args) =>
      remoteStore('notifications', args, 'unreadCount', 0).subscribe(() => {})
    );
    // `JSON.stringify` would have folded both functions into `[null]` and shared them.
    expect(subs(f.sent)).toHaveLength(odd.length);
    for (const off of offs) off();
    expect(unsubs(f.sent)).toHaveLength(odd.length);
  });

  it('does not hand a reader a wire that lives on a replaced transport', () => {
    const before = fakeTransport();
    const stale = remoteStore('streamer', [], 'enabled', false).subscribe(() => {});
    const after = fakeTransport();
    const fresh = remoteStore('streamer', [], 'enabled', false).subscribe(() => {});
    expect(subs(before.sent)).toHaveLength(1);
    expect(subs(after.sent)).toHaveLength(1);
    fresh();
    expect(unsubs(after.sent)).toHaveLength(1);
    stale();
    expect(unsubs(before.sent)).toHaveLength(1);
  });
});

describe('remoteFn', () => {
  it('invokes the handle', () => {
    const f = fakeTransport();
    remoteFn({ __fn: 9 })('a');
    expect(f.sent[0]).toEqual({ kind: 'invoke', handle: 9, args: ['a'] });
  });
});
