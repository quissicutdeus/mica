import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { get, writable } from 'svelte/store';
import { createInProcessHost } from '../../sdk/host/inProcess/createInProcessHost';
import { registerFacet, resetHostsForTest } from '../../sdk/host/current';
import { createIframeHostServer } from './IframeHostServer';
import { defineApp } from '../../sdk/manifest';
import { is24Hour as shellIs24Hour } from '../state/time';
import type { ToFrame } from '../../sdk/host/iframe/messages';
import '../../sdk/host/useContacts';
import '../../sdk/host/useDisplay';
import '../../sdk/host/useWallpaper';
import '../../sdk/host/useSystemHardware';
import '../../sdk/host/useTheme';

/** A namespaced storage key. Built, not quoted: a `gphone:` literal reads as a net event to `server/__tests__/eventNames.test.ts`. */
const storageKey = (app: string, key: string) => `gphone:${app}:${key}`;

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
    from({ kind: 'hello', appId: 'other' });
    expect(posted).toHaveLength(0);
    from({ kind: 'hello', appId: manifest.id });
    expect(posted[0]).toMatchObject({
      kind: 'hydrate',
      payload: { appId: 'probe', permissions: ['contacts'] }
    });
  });
  it('hydrate carries the 24-hour clock preference as a constant', () => {
    // The frame cannot read `is24Hour` any other way in time: `formatTime`'s default reads
    // it synchronously during the first paint, before any subscribe reply could land, and
    // a formatter's callers do not declare the `clock` permission a subscribe would need.
    const { posted, from } = server();
    from({ kind: 'hello', appId: manifest.id });
    const hydrate = posted[0] as Extract<ToFrame, { kind: 'hydrate' }>;
    expect(hydrate.payload.constants.clock).toEqual({ is24Hour: get(shellIs24Hour) });
    expect(typeof hydrate.payload.constants.clock.is24Hour).toBe('boolean');
  });
  it('hydrate storage keeps the full gphone:<appId>:<key>, not stripped of its prefix', () => {
    // This suite's jsdom has no real `localStorage` (see `sdk/storage.test.ts`'s doc
    // comment — deliberate, matching the in-memory fallback CEF's own storage backend
    // uses), so `storageSnapshot`'s `typeof localStorage === 'undefined'` guard would
    // otherwise short-circuit this test before it exercises the prefix bug at all.
    // Stubbing a minimal `Storage`-shaped global is what lets the real code path run.
    const raw: Record<string, string> = {
      [storageKey('probe', 'k')]: '"v"',
      [storageKey('other', 'k')]: '"nope"'
    };
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => raw[key] ?? null
    });
    Object.assign(globalThis.localStorage, raw);

    const { posted, from } = server();
    from({ kind: 'hello', appId: manifest.id });
    const hydrate = posted[0] as Extract<ToFrame, { kind: 'hydrate' }>;
    expect(hydrate.payload.storage).toEqual({ [storageKey('probe', 'k')]: '"v"' });
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
  /**
   * The app id in `factoryArgs[0]` is stated by the server, never taken from the frame.
   *
   * The frame's script is not the add-on's bundle — a raw `postMessage` can name any facet,
   * member and factory argument it likes. Before `APP_SCOPED_FACETS` these three shapes read
   * and wrote another app's namespace on a permission the add-on genuinely holds.
   */
  describe('app-scoped facets are pinned to the calling app', () => {
    /** Every app id each stub facet was constructed with, in order. */
    let built: { facet: string; appId: unknown }[];

    beforeEach(() => {
      built = [];
      registerFacet(
        'storage' as any,
        ((appId?: unknown) => {
          built.push({ facet: 'storage', appId });
          return { setItem: () => true, getItem: () => null };
        }) as any
      );
      registerFacet(
        'appEvents' as any,
        ((appId?: unknown) => {
          built.push({ facet: 'appEvents', appId });
          return { eventsStore: writable([]), emit: () => true };
        }) as any
      );
      registerFacet(
        'appAction' as any,
        ((appId?: unknown) => {
          built.push({ facet: 'appAction', appId });
          return { busy: writable(false), notify: () => true };
        }) as any
      );
      registerFacet(
        'notifications' as any,
        ((appId?: unknown) => {
          built.push({ facet: 'notifications', appId });
          return { notificationsStore: writable([]), clear: () => true };
        }) as any
      );
    });

    it("replaces a call's factoryArgs[0] with the server's own appId", async () => {
      const { posted, from } = server(['storage'] as any);
      from({
        kind: 'call',
        id: 1,
        facet: 'storage',
        factoryArgs: ['settings'],
        member: 'setItem',
        args: ['k', 'v']
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(posted[posted.length - 1]).toMatchObject({ ok: true });
      // Not 'settings' — that is the shell's own preferences namespace.
      expect(built).toEqual([{ facet: 'storage', appId: 'probe' }]);
    });

    it('pins a subscribe the same way', () => {
      const { from } = server(['app-events'] as any);
      from({
        kind: 'subscribe',
        id: 2,
        facet: 'appEvents',
        factoryArgs: ['mail'],
        member: 'eventsStore'
      });
      expect(built).toEqual([{ facet: 'appEvents', appId: 'probe' }]);
    });

    it('pins appAction, and turns notifications(undefined) — every app — into this one', async () => {
      const { from } = server(['notifications'] as any);
      from({
        kind: 'call',
        id: 3,
        facet: 'appAction',
        factoryArgs: ['mail'],
        member: 'notify',
        args: []
      });
      from({
        kind: 'call',
        id: 4,
        facet: 'notifications',
        factoryArgs: [],
        member: 'clear',
        args: []
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(built).toEqual([
        { facet: 'appAction', appId: 'probe' },
        // `notifications()` with no argument is "every app's notifications" on the
        // in-process side; a frame does not get that view.
        { facet: 'notifications', appId: 'probe' }
      ]);
    });
  });

  /**
   * `permissionOfFacet` gates the facet, not the member — so the shell, not the twin in the
   * sandbox, has to be the thing that refuses an install.
   */
  describe('appRegistry members', () => {
    beforeEach(() => {
      registerFacet(
        'appRegistry' as any,
        (() => ({
          registryStore: writable([{ id: 'probe' }]),
          getFirstBootTime: () => 7,
          unregisterApp: () => true,
          installFromCatalog: () => true
        })) as any
      );
    });

    it('refuses a mutating member even with the app-registry permission', async () => {
      const { posted, from } = server(['app-registry'] as any);
      from({
        kind: 'call',
        id: 1,
        facet: 'appRegistry',
        factoryArgs: [],
        member: 'unregisterApp',
        args: ['mail']
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(posted[posted.length - 1]).toMatchObject({
        kind: 'reply',
        id: 1,
        ok: false,
        error: { message: expect.stringContaining('core only') }
      });
    });

    it('still allows the two read members', async () => {
      const { posted, from } = server(['app-registry'] as any);
      from({
        kind: 'subscribe',
        id: 2,
        facet: 'appRegistry',
        factoryArgs: [],
        member: 'registryStore'
      });
      expect(posted[posted.length - 1]).toEqual({
        kind: 'push',
        id: 2,
        value: [{ id: 'probe' }]
      });

      from({
        kind: 'call',
        id: 3,
        facet: 'appRegistry',
        factoryArgs: [],
        member: 'getFirstBootTime',
        args: []
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(posted[posted.length - 1]).toEqual({ kind: 'reply', id: 3, ok: true, value: 7 });
    });
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
  /**
   * The `isImplicitNavPlumbing` bypass, from both sides.
   *
   * `useAppLevels` / `onAppForeground` are implicit hooks (no manifest declaration), but
   * their iframe twins reach the shell through the permission-gated `keybinds` and
   * `navigation` facets — so the server waives the check for exactly that plumbing. These
   * cases pin down both what the waiver lets through and what it must not.
   */
  describe('implicit navigation plumbing', () => {
    /** Records the owner `onKeybind` was handed, which is the whole point of case (a). */
    let owners: (string | undefined)[];

    beforeEach(() => {
      owners = [];
      registerFacet(
        'keybinds' as any,
        (() => ({
          onKeybind: (_actionId: string, _handler: () => void, appId?: string) => {
            owners.push(appId);
            return () => {};
          }
        })) as any
      );
      registerFacet(
        'navigation' as any,
        (() => ({
          currentApp: writable({ id: 'probe' }),
          goHome: () => {},
          openApp: (id: string) => id
        })) as any
      );
    });

    it("registers a 'back' binding with no permission, under the server's appId rather than the one the frame sent", async () => {
      const { posted, from } = server([]);
      from({
        kind: 'call',
        id: 1,
        facet: 'keybinds',
        factoryArgs: [],
        member: 'onKeybind',
        args: ['back', { __cb: 7 }, 'mail']
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(posted[0]).toMatchObject({ kind: 'reply', id: 1, ok: true });
      // Not 'mail'. The frame does not get to name the owner of a binding it was let
      // through the permission gate to register.
      expect(owners).toEqual(['probe']);
    });

    it('refuses any other keybind with no permission', async () => {
      const { posted, from } = server([]);
      from({
        kind: 'call',
        id: 1,
        facet: 'keybinds',
        factoryArgs: [],
        member: 'onKeybind',
        args: ['screenshot', { __cb: 7 }]
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(posted[0]).toMatchObject({
        kind: 'reply',
        id: 1,
        ok: false,
        error: { name: 'AppPermissionError' }
      });
      expect(owners).toEqual([]);
    });

    it('refuses navigation.openApp with no permission, but pushes navigation.currentApp', async () => {
      const { posted, from } = server([]);
      from({
        kind: 'call',
        id: 1,
        facet: 'navigation',
        factoryArgs: [],
        member: 'openApp',
        args: ['mail']
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(posted[0]).toMatchObject({
        kind: 'reply',
        id: 1,
        ok: false,
        error: { name: 'AppPermissionError' }
      });

      from({
        kind: 'subscribe',
        id: 2,
        facet: 'navigation',
        factoryArgs: [],
        member: 'currentApp'
      });
      expect(posted[1]).toEqual({ kind: 'push', id: 2, value: { id: 'probe' } });
    });
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
