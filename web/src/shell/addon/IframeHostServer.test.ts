import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writable } from 'svelte/store';
import { createInProcessHost } from '../../sdk/host/inProcess/createInProcessHost';
import { registerFacet, resetHostsForTest } from '../../sdk/host/current';
import { createIframeHostServer } from './IframeHostServer';
import { defineApp } from '../../sdk/manifest';
import type { ToFrame } from '../../sdk/host/iframe/messages';
import '../../sdk/host/useContacts';
import '../../sdk/host/useDisplay';
import '../../sdk/host/useWallpaper';
import '../../sdk/host/useSystemHardware';
import '../../sdk/host/useTheme';

const manifest = defineApp({
  id: 'probe',
  name: 'Probe',
  icon: 'x',
  color: '#000',
  core: false,
  permissions: ['contacts']
} as any);

function server(permissions = manifest.permissions!) {
  const posted: ToFrame[] = [];
  const source = {};
  const s = createIframeHostServer({
    host: createInProcessHost('probe', permissions),
    manifest,
    props: {},
    target: { postMessage: (m) => posted.push(m) },
    source,
    onError: vi.fn(),
    onKey: vi.fn(),
    onTyping: vi.fn()
  });
  const from = (data: unknown, src: unknown = source) =>
    s.handle({ data, source: src } as MessageEvent);
  return { posted, from, s };
}

beforeEach(() => {
  resetHostsForTest();
  // A stand-in facet: a store member and a function member that takes a callback and returns a release.
  const store = writable(1);
  registerFacet(
    'contacts' as any,
    (() => ({
      contactsStore: store,
      addContact: (first: string) => Promise.resolve({ id: first.length }),
      watch: (cb: (n: number) => void) => {
        cb(42);
        return () => cb(-1);
      }
    })) as any
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('IframeHostServer', () => {
  it('ignores messages from any other source', () => {
    const { posted, from } = server();
    from(
      {
        kind: 'call',
        id: 1,
        facet: 'contacts',
        factoryArgs: [],
        member: 'addContact',
        args: ['ab']
      },
      {}
    );
    expect(posted).toHaveLength(0);
  });
  it('answers hello with hydrate and refuses a hello whose id is not the manifest', () => {
    const { posted, from } = server();
    from({ kind: 'hello', manifest: { ...manifest, id: 'other' } });
    expect(posted).toHaveLength(0);
    from({ kind: 'hello', manifest });
    expect(posted[0]).toMatchObject({
      kind: 'hydrate',
      payload: { appId: 'probe', permissions: ['contacts'] }
    });
  });
  it('hydrate storage keeps the full gphone:<appId>:<key>, not stripped of its prefix', () => {
    // This suite's jsdom has no real `localStorage` (see `sdk/storage.test.ts`'s doc
    // comment — deliberate, matching the in-memory fallback CEF's own storage backend
    // uses), so `storageSnapshot`'s `typeof localStorage === 'undefined'` guard would
    // otherwise short-circuit this test before it exercises the prefix bug at all.
    // Stubbing a minimal `Storage`-shaped global is what lets the real code path run.
    const raw: Record<string, string> = {
      'gphone:probe:k': '"v"',
      'gphone:other:k': '"nope"'
    };
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => raw[key] ?? null
    });
    Object.assign(globalThis.localStorage, raw);

    const { posted, from } = server();
    from({ kind: 'hello', manifest });
    const hydrate = posted[0] as Extract<ToFrame, { kind: 'hydrate' }>;
    expect(hydrate.payload.storage).toEqual({ 'gphone:probe:k': '"v"' });
  });
  it('calls a member and replies with the awaited value', async () => {
    const { posted, from } = server();
    from({
      kind: 'call',
      id: 1,
      facet: 'contacts',
      factoryArgs: [],
      member: 'addContact',
      args: ['ab']
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(posted[posted.length - 1]).toEqual({ kind: 'reply', id: 1, ok: true, value: { id: 2 } });
  });
  it('refuses an undeclared facet with an AppPermissionError reply', async () => {
    const { posted, from } = server([]);
    from({
      kind: 'call',
      id: 1,
      facet: 'contacts',
      factoryArgs: [],
      member: 'addContact',
      args: ['ab']
    });
    await Promise.resolve();
    expect(posted[posted.length - 1]).toMatchObject({
      kind: 'reply',
      id: 1,
      ok: false,
      error: { name: 'AppPermissionError', permission: 'contacts', hookName: 'useContacts' }
    });
  });
  it('refuses a member that is not a function, and an unknown facet', async () => {
    const { posted, from } = server();
    from({
      kind: 'call',
      id: 1,
      facet: 'contacts',
      factoryArgs: [],
      member: 'contactsStore',
      args: []
    });
    from({ kind: 'call', id: 2, facet: 'nope', factoryArgs: [], member: 'x', args: [] });
    await Promise.resolve();
    expect(posted.map((m) => (m as any).ok)).toEqual([false, false]);
  });
  it('subscribes a store member, pushes values, stops on unsubscribe', () => {
    const { posted, from } = server();
    from({ kind: 'subscribe', id: 5, facet: 'contacts', factoryArgs: [], member: 'contactsStore' });
    expect(posted[posted.length - 1]).toEqual({ kind: 'push', id: 5, value: 1 });
    from({ kind: 'unsubscribe', id: 5 });
    expect(posted).toHaveLength(1);
  });
  it('turns callback refs into live callbacks and function results into invokable handles', async () => {
    const { posted, from } = server();
    from({
      kind: 'call',
      id: 1,
      facet: 'contacts',
      factoryArgs: [],
      member: 'watch',
      args: [{ __cb: 3 }]
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(posted[0]).toEqual({ kind: 'callback', cb: 3, args: [42] });
    const reply = posted[1] as any;
    expect(reply.value).toEqual({ __fn: expect.any(Number) });
    from({ kind: 'invoke', handle: reply.value.__fn, args: [] });
    expect(posted[posted.length - 1]).toEqual({ kind: 'callback', cb: 3, args: [-1] });
  });
  it('pins service ids to the app namespace', async () => {
    registerFacet(
      'service' as any,
      ((id: string) => ({ id, call: () => Promise.resolve('ok') })) as any
    );
    const { posted, from } = server([]); // useService is implicit (PERMISSION_OF.useService === null)
    from({
      kind: 'call',
      id: 1,
      facet: 'service',
      factoryArgs: ['probe_dms'],
      member: 'call',
      args: ['list']
    });
    from({
      kind: 'call',
      id: 2,
      facet: 'service',
      factoryArgs: ['accounts'],
      member: 'call',
      args: ['list']
    });
    await Promise.resolve();
    await Promise.resolve();
    expect((posted[0] as any).ok).toBe(true);
    expect(posted[1]).toMatchObject({ ok: false, error: { name: 'Error' } });
  });
  it('forwards error, key and typing to the callbacks', () => {
    const onError = vi.fn(),
      onKey = vi.fn(),
      onTyping = vi.fn();
    const source = {};
    const s = createIframeHostServer({
      host: createInProcessHost('probe', []),
      manifest,
      props: {},
      target: { postMessage: () => {} },
      source,
      onError,
      onKey,
      onTyping
    });
    s.handle({ data: { kind: 'error', message: 'boom', stack: null }, source } as MessageEvent);
    s.handle({ data: { kind: 'typing', typing: true }, source } as MessageEvent);
    expect(onError).toHaveBeenCalledWith('boom', null);
    expect(onTyping).toHaveBeenCalledWith(true);
  });
});
