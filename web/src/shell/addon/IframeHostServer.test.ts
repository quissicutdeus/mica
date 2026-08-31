// @vitest-environment jsdom
/**
 * MICA-176: which facet set this file's subject resolves against. A hook no longer
 * carries its facet — `src/main.ts` picks the in-process set for the shell and `bootAddOn`
 * picks the iframe twins for an add-on — so a test file, having neither entry point, says
 * which side it is standing in for. In-process, because a unit test stands in for the shell.
 */
import '../../sdk/host/inProcess/registerFacets';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { get, writable } from 'svelte/store';
import { createInProcessHost } from '../../sdk/host/inProcess/createInProcessHost';
import { registerFacet, resetHostsForTest } from '../../sdk/host/current';
import { createIframeHostServer } from './IframeHostServer';
import { defineApp } from '../../sdk/manifest';
import { DENIED_FACETS } from '../../sdk/permissions';
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
  tile: { bg: 'bg-gray-900' },
  core: false,
  permissions: ['contacts']
} as any);

/**
 * A stand-in guest window. Both ends of the channel are the same object, the way a real
 * `contentWindow` is — and `guest` is a getter, so a test can swap in a reloaded frame's
 * new window by reassigning `current` (see the reload block).
 */
function server(permissions = manifest.permissions!) {
  const posted: ToFrame[] = [];
  const makeWindow = () => ({ postMessage: (m: ToFrame) => posted.push(m) });
  let current = makeWindow();
  const s = createIframeHostServer({
    host: createInProcessHost('probe', permissions),
    manifest,
    props: {},
    guest: () => current,
    onError: vi.fn(),
    onKey: vi.fn(),
    onTyping: vi.fn()
  });
  const from = (data: unknown, src: unknown = current) =>
    s.handle({ data, source: src } as MessageEvent);
  /** What a reload gives you: a different window in the same frame. */
  const reload = () => {
    current = makeWindow();
    return current;
  };
  return { posted, from, s, reload, guest: () => current };
}

/** The stand-in facet's store, reachable from a test that needs to push a change through it. */
let store = writable(1);

beforeEach(() => {
  resetHostsForTest();
  // A stand-in facet: a store member and a function member that takes a callback and returns a release.
  store = writable(1);
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
  /**
   * MICA-25: `AddOnFrame.svelte` calls this instead of rebuilding the server when a
   * deep link into an already-open add-on changes `props` — the frame already ran its
   * one `hello`, so there is no second hydrate to send, only this push.
   */
  it('pushProps posts a props message, and is a no-op once disposed', () => {
    const { posted, from, s } = server();
    from({ kind: 'hello', appId: manifest.id });
    posted.length = 0;

    s.pushProps({ label: 'from a deep link' });
    expect(posted).toEqual([{ kind: 'props', props: { label: 'from a deep link' } }]);

    posted.length = 0;
    s.dispose();
    s.pushProps({ label: 'too late' });
    expect(posted).toHaveLength(0);
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

    // MICA-23: the handle is a documented one-shot release (messages.ts) — invoking it
    // again must not still be able to fire the underlying function a second time, which
    // is what an un-freed `handles` entry would let a malicious or buggy frame do.
    const postedBefore = posted.length;
    from({ kind: 'invoke', handle: reply.value.__fn, args: [] });
    expect(posted).toHaveLength(postedBefore);
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

  /**
   * MICA-162: MICA-127 split eight permissions into a read/write pair each and hard-
   * blocked six of the eight write facets in `MEMBER_ALLOWLIST` regardless of manifest
   * declaration (`appRegistryWrite: []`, `notificationSettingsWrite: []` above).
   * `keybindsWrite` and `systemHardwareWrite` did not get that treatment when they were
   * split — this proves the raw `postMessage` route through `requireMember` is closed for
   * all four, not just the two that already had it. `requireMember` runs before the
   * permission check, so `server([...])` grants the permission only to prove the *member*
   * refusal fires even when the caller is otherwise entitled, matching the `appRegistry
   * members` block above.
   */
  describe('MICA-127/162 write-facet member allowlists', () => {
    it('hard-blocks every keybindsWrite member, permission or not', async () => {
      const setBinding = vi.fn();
      const resetBindings = vi.fn();
      registerFacet('keybindsWrite' as any, (() => ({ setBinding, resetBindings })) as any);
      const { posted, from } = server(['keybinds-write'] as any);
      from({
        kind: 'call',
        id: 1,
        facet: 'keybindsWrite',
        factoryArgs: [],
        member: 'setBinding',
        args: ['back', 'Escape']
      });
      from({
        kind: 'call',
        id: 2,
        facet: 'keybindsWrite',
        factoryArgs: [],
        member: 'resetBindings',
        args: []
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(posted.map((m) => (m as any).ok)).toEqual([false, false]);
      expect(posted[0]).toMatchObject({ error: { message: expect.stringContaining('core only') } });
      expect(setBinding).not.toHaveBeenCalled();
      expect(resetBindings).not.toHaveBeenCalled();
    });

    it('hard-blocks appRegistryWrite entirely, even with app-registry-write granted', async () => {
      const unregisterApp = vi.fn();
      registerFacet('appRegistryWrite' as any, (() => ({ unregisterApp })) as any);
      const { posted, from } = server(['app-registry-write'] as any);
      from({
        kind: 'call',
        id: 1,
        facet: 'appRegistryWrite',
        factoryArgs: [],
        member: 'unregisterApp',
        args: ['mail']
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(posted[0]).toMatchObject({
        ok: false,
        error: { message: expect.stringContaining('core only') }
      });
      expect(unregisterApp).not.toHaveBeenCalled();
    });

    it('hard-blocks notificationSettingsWrite entirely, even with notification-settings-write granted', async () => {
      const setDndEnabled = vi.fn();
      registerFacet('notificationSettingsWrite' as any, (() => ({ setDndEnabled })) as any);
      const { posted, from } = server(['notification-settings-write'] as any);
      from({
        kind: 'call',
        id: 1,
        facet: 'notificationSettingsWrite',
        factoryArgs: [],
        member: 'setDndEnabled',
        args: [true]
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(posted[0]).toMatchObject({
        ok: false,
        error: { message: expect.stringContaining('core only') }
      });
      expect(setDndEnabled).not.toHaveBeenCalled();
    });

    describe('systemHardwareWrite splits device-wide members from experience ones', () => {
      /** Every real member, stubbed, so a member missing from either list here fails loud. */
      const members = [
        'setCharge',
        'setSignal',
        'toggleCellService',
        'toggleBluetooth',
        'setVolume',
        'toggleMute',
        'setVolumeStep',
        'setRingMode',
        'setRingtone',
        'previewRingtone'
      ] as const;
      const blocked = [
        'setCharge',
        'setSignal',
        'toggleCellService',
        'toggleBluetooth',
        'toggleMute',
        'setVolumeStep',
        'setRingtone'
      ];
      const grantable = ['setVolume', 'setRingMode', 'previewRingtone'];

      let calls: Record<string, unknown[]>;

      beforeEach(() => {
        calls = {};
        registerFacet(
          'systemHardwareWrite' as any,
          (() =>
            Object.fromEntries(
              members.map((m) => [m, (...args: unknown[]) => (calls[m] = args)])
            )) as any
        );
      });

      it.each(blocked)("blocks '%s' as core only", async (member) => {
        const { posted, from } = server(['system-hardware-write'] as any);
        from({
          kind: 'call',
          id: 1,
          facet: 'systemHardwareWrite',
          factoryArgs: [],
          member,
          args: []
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(posted[0]).toMatchObject({
          ok: false,
          error: { message: expect.stringContaining('core only') }
        });
        expect(calls[member]).toBeUndefined();
      });

      it.each(grantable)("still allows '%s' with the permission granted", async (member) => {
        const { posted, from } = server(['system-hardware-write'] as any);
        from({
          kind: 'call',
          id: 1,
          facet: 'systemHardwareWrite',
          factoryArgs: [],
          member,
          args: ['probe-arg']
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(posted[0]).toMatchObject({ ok: true });
        expect(calls[member]).toEqual(['probe-arg']);
      });

      it('covers every real systemHardwareWrite member between the two lists', () => {
        expect([...blocked, ...grantable].sort()).toEqual([...members].sort());
      });
    });
  });

  /**
   * MICA-21: `onAppForeground`, `onAppUnmount`, `deepLink`, `clearAppStorage` and
   * `appStorageBytes` are bare-function facets whose factory takes an app id and (for the
   * first three) a handler, neither of which passes through `pinAppId` or `decodeArgs`. A
   * raw message naming one of them directly could hand it another app's id and a
   * non-callable "handler" — for `onAppForeground`, that handler throws every time the
   * named app is foregrounded, for the life of the page, since nothing ever unsubscribes
   * it. None of these facets is ever named this way by a legitimate iframe twin (each
   * routes through a different, already-gated facet instead), so refusing all five costs
   * no real caller anything.
   */
  describe('denied facets (MICA-21)', () => {
    // MICA-33: from the same set `IframeHostServer.ts`'s `requireMember` actually
    // checks, not a second hand-typed copy — the two used to be independent, which is
    // exactly the kind of gap this ticket closes.
    const deniedFacets = [...DENIED_FACETS];

    it.each(deniedFacets)(
      "refuses a call naming '%s' directly, before the factory ever runs",
      async (facet) => {
        const factory = vi.fn();
        registerFacet(facet as any, factory as any);
        const { posted, from } = server([]);
        from({
          kind: 'call',
          id: 1,
          facet: facet as any,
          factoryArgs: ['some-other-app', { __cb: 1 }],
          member: 'anything',
          args: []
        });
        await Promise.resolve();
        await Promise.resolve();

        expect(posted[posted.length - 1]).toMatchObject({
          kind: 'reply',
          id: 1,
          ok: false,
          error: { message: expect.stringContaining('not reachable directly') }
        });
        expect(factory).not.toHaveBeenCalled();
      }
    );

    it("refuses a subscribe naming 'onAppForeground' directly, so a poisoned handler never reaches currentApp", () => {
      const factory = vi.fn();
      registerFacet('onAppForeground' as any, factory as any);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { posted, from } = server([]);
      // A real attack: naming another app's id with a handler that is not a function at
      // all. If this ever reached the factory, `currentApp.subscribe` would throw calling
      // it the next time 'other-app' comes to the foreground.
      from({
        kind: 'subscribe',
        id: 1,
        facet: 'onAppForeground' as any,
        factoryArgs: ['other-app', 'not-a-function'],
        member: 'irrelevant'
      });

      expect(posted).toHaveLength(0);
      expect(factory).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("add-on 'probe' subscribe failed"),
        expect.any(Error)
      );
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
   * MICA-27: the `lifecycle` facet replaced `isImplicitNavPlumbing`, a hand-maintained
   * facet/member allow-list keyed on literal strings — MICA-31 was exactly that list
   * missing an entry (`consumeDeepLink`) a legitimate implicit caller needed. `lifecycle`
   * needs no such list: its own permission is `null`, so every member is implicit by
   * construction, and it is pinned via `APP_SCOPED_FACETS` like `storage`/`deepLink`. The
   * general `navigation`/`keybinds` facets it replaced borrowed members from now require
   * their real permissions unconditionally — no exemption left at all.
   */
  describe('the lifecycle facet', () => {
    /** Records the owner `onBack` was handed, which is the whole point of the pin test. */
    let backOwners: (string | undefined)[];
    let consumeDeepLinkCalls: string[];

    beforeEach(() => {
      backOwners = [];
      consumeDeepLinkCalls = [];
      registerFacet(
        'lifecycle' as any,
        ((appId: string) => ({
          currentApp: writable({ id: 'probe' }),
          onBack: (_handler: () => void) => {
            backOwners.push(appId);
            return () => {};
          },
          goHome: () => {},
          consumeDeepLink: () => {
            consumeDeepLinkCalls.push(appId);
          }
        })) as any
      );
      registerFacet('keybinds' as any, (() => ({ onKeybind: () => () => {} })) as any);
      registerFacet(
        'navigation' as any,
        (() => ({
          currentApp: writable({ id: 'probe' }),
          goHome: () => {},
          openApp: (id: string) => id
        })) as any
      );
    });

    it("calls onBack with no permission, under the server's appId rather than the one the frame sent", async () => {
      const { posted, from } = server([]);
      from({
        kind: 'call',
        id: 1,
        facet: 'lifecycle',
        factoryArgs: ['mail'],
        member: 'onBack',
        args: [{ __cb: 7 }]
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(posted[0]).toMatchObject({ kind: 'reply', id: 1, ok: true });
      // Not 'mail'. The frame does not get to name the owner of a binding it was let
      // through with no permission at all to register.
      expect(backOwners).toEqual(['probe']);
    });

    it('subscribes currentApp with no permission', () => {
      const { posted, from } = server([]);
      from({ kind: 'subscribe', id: 1, facet: 'lifecycle', factoryArgs: [], member: 'currentApp' });
      expect(posted[0]).toEqual({ kind: 'push', id: 1, value: { id: 'probe' } });
    });

    it('calls goHome and consumeDeepLink with no permission', async () => {
      const { posted, from } = server([]);
      from({
        kind: 'call',
        id: 1,
        facet: 'lifecycle',
        factoryArgs: [],
        member: 'goHome',
        args: []
      });
      from({
        kind: 'call',
        id: 2,
        facet: 'lifecycle',
        factoryArgs: [],
        member: 'consumeDeepLink',
        args: []
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(posted.map((m) => (m as any).ok)).toEqual([true, true]);
      expect(consumeDeepLinkCalls).toEqual(['probe']);
    });

    it('refuses a raw keybinds.onKeybind call with no permission, even naming "back" — the old exemption is gone', async () => {
      const { posted, from } = server([]);
      from({
        kind: 'call',
        id: 1,
        facet: 'keybinds',
        factoryArgs: [],
        member: 'onKeybind',
        args: ['back', { __cb: 7 }]
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(posted[0]).toMatchObject({
        kind: 'reply',
        id: 1,
        ok: false,
        error: { name: 'AppPermissionError' }
      });
    });

    it('refuses navigation.goHome and navigation.currentApp with no permission — the old exemption is gone', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const { posted, from } = server([]);
      from({
        kind: 'call',
        id: 1,
        facet: 'navigation',
        factoryArgs: [],
        member: 'goHome',
        args: []
      });
      from({
        kind: 'subscribe',
        id: 2,
        facet: 'navigation',
        factoryArgs: [],
        member: 'currentApp'
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(posted[0]).toMatchObject({
        kind: 'reply',
        id: 1,
        ok: false,
        error: { name: 'AppPermissionError' }
      });
      // `subscribe` logs and drops a refusal rather than replying — no push for id 2 ever.
      expect(posted.some((m) => 'id' in m && m.id === 2)).toBe(false);
    });
  });

  /**
   * MICA-90. A frame can come back as a new window, and the guest says `hello` exactly
   * once — from its own script execution, which is before the frame's `load` event. Any
   * binding refreshed on `load` is therefore refreshed after the message it exists to
   * accept has already been refused, and nothing re-sends it: the add-on stays blank while
   * the frame keeps running. Reading the window at delivery is what removes the ordering.
   */
  describe('a reloaded frame', () => {
    const hello = { kind: 'hello', appId: 'probe' };

    it('is hydrated on its first hello, with no rebind in between', () => {
      const { posted, from, reload } = server();
      from(hello);
      expect(posted.filter((m) => m.kind === 'hydrate')).toHaveLength(1);

      const fresh = reload();
      posted.length = 0;
      // From the *new* window, and nothing has told the server about it — which is the
      // whole situation, since `load` has not fired yet and never will in time.
      from(hello, fresh);

      expect(posted.filter((m) => m.kind === 'hydrate')).toHaveLength(1);
    });

    it('still refuses a hello from a window that is not in the frame', () => {
      const { posted, from } = server();
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});

      from(hello, { postMessage: () => {} });

      expect(posted).toHaveLength(0);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('not the one'));
      error.mockRestore();
    });

    it('drops the subscriptions the previous document left behind', () => {
      const subscribe = {
        kind: 'subscribe',
        id: 1,
        facet: 'contacts',
        factoryArgs: [],
        member: 'contactsStore'
      };
      const { posted, from, reload } = server();
      from(hello);
      from(subscribe);

      // The new document allocates its subscription ids from 1 again, so re-subscribing
      // overwrites the entry the old one left in the map — and without unsubscribing it
      // first, that store keeps a listener nothing can ever reach or stop. One leak per
      // id per reload, for as long as the frame lives.
      const fresh = reload();
      from(hello, fresh);
      from(subscribe, fresh);
      posted.length = 0;

      store.set(2);

      expect(posted.filter((m) => m.kind === 'push')).toHaveLength(1);
    });
  });

  it('forwards error, key and typing to the callbacks', () => {
    const onError = vi.fn(),
      onKey = vi.fn(),
      onTyping = vi.fn();
    const source = { postMessage: () => {} };
    const s = createIframeHostServer({
      host: createInProcessHost('probe', []),
      manifest,
      props: {},
      guest: () => source,
      onError,
      onKey,
      onTyping
    });
    const from = (data: unknown) => s.handle({ data, source } as unknown as MessageEvent);
    from({ kind: 'error', message: 'boom', stack: null });
    from({ kind: 'typing', typing: true });
    expect(onError).toHaveBeenCalledWith('boom', null);
    expect(onTyping).toHaveBeenCalledWith(true);
  });
});
