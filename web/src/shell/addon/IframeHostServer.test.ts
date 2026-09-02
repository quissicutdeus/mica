// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
/**
 * MICA-176: which facet set this file's subject resolves against. A hook no longer
 * carries its facet — `src/main.ts` picks the in-process set for the shell and `bootAddOn`
 * picks the iframe twins for an add-on — so a test file, having neither entry point, says
 * which side it is standing in for. In-process, because a unit test stands in for the shell.
 */
import '../../host/registerFacets';
import type { AppPermission } from '@gphone/sdk';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { get, writable } from 'svelte/store';
import { createInProcessHost } from '../../../../sdk/host/inProcess/createInProcessHost';
import { registerFacet, resetHostsForTest } from '../../../../sdk/host/current';
import { ADDON_LIMITS, createIframeHostServer } from './IframeHostServer';
import { defineApp } from '../../../../sdk/manifest';
import { DENIED_FACETS } from '../../../../sdk/permissions';
import { SDK_CONTRACT_VERSION } from '../../../../sdk/version';
import { is24Hour as shellIs24Hour } from '../state/time';
import { recordConsent, resetGrantsForTest } from '../state/addOnGrants';
import type { ToFrame } from '../../../../sdk/host/iframe/messages';
import '../../../../sdk/host/useContacts';
import '../../../../sdk/host/useDisplay';
import '../../../../sdk/host/useWallpaper';
import '../../../../sdk/host/useSystemHardware';
import '../../../../sdk/host/useTheme';

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
/**
 * MICA-201: `granted` defaults to `permissions` because every test here that is not
 * about consent wants an add-on the player has actually accepted — the shell refuses a
 * declared permission with no grant behind it, so an unseeded server would refuse nearly
 * every call in this file for a reason none of those tests are about. Pass a narrower set
 * (or none) to play the add-on whose manifest asks for more than its player agreed to.
 */
function server(permissions = manifest.permissions!, granted = permissions) {
  recordConsent('probe', granted);
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
  /**
   * `origin` defaults to `'null'` because that is what a real guest sends: a
   * `sandbox="allow-scripts"` srcdoc document has an opaque origin, which serialises to the
   * literal string `"null"`. MICA-196 made the server check it, so a synthetic event that
   * leaves it `undefined` is refused — and refused *loudly*, since the only way to reach a
   * real origin from the window in the frame is a self-navigation. Pass one explicitly to
   * play the navigated guest.
   */
  const from = (data: unknown, src: unknown = current, origin = 'null') =>
    s.handle({ data, source: src, origin } as MessageEvent);
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
  resetGrantsForTest();
  // A stand-in facet: a store member and a function member that takes a callback and returns a release.
  store = writable(1);
  /**
   * The member names are real `contacts` members, not invented ones, because
   * `requireMember` is default-deny since MICA-196: it checks the name against
   * `FACET_MEMBERS` before the facet is ever constructed, so a stand-in called `watch`
   * would be refused before any of this ran. What each one *does* here is still a
   * stand-in — `restoreContact` takes a callback and hands back a release, which is the
   * shape the callback-ref and handle machinery below needs to exercise.
   */
  registerFacet(
    'contacts' as any,
    (() => ({
      contactsStore: store,
      addContact: (first: string) => Promise.resolve({ id: first.length }),
      restoreContact: (cb: (n: number) => void) => {
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
  /**
   * MICA-201. Consent is the shell's record, not the manifest's — an add-on whose
   * manifest declares `contacts` reaches nothing until the player's own answer says so,
   * which is what stops a widened manifest (a modified Store, a core path that writes one)
   * from being its own authorization. Driven through `postMessage`, because that is the
   * only route a sandboxed add-on has and the frame's own `require` runs inside it.
   */
  it('refuses a declared permission the player never granted', async () => {
    const { posted, from } = server(['contacts'] as AppPermission[], []);
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
  it('refuses a permission an update added but the grant does not carry yet', async () => {
    // The update case exactly: installed and granted `storage`, republished asking for
    // `contacts` too. The wider manifest answers nothing extra until the grant widens.
    const { posted, from } = server(
      ['storage', 'contacts'] as AppPermission[],
      ['storage'] as AppPermission[]
    );
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
      error: { name: 'AppPermissionError', permission: 'contacts' }
    });
  });
  it('hydrates the frame with the granted subset, so both checks agree', () => {
    const { posted, from } = server(
      ['storage', 'contacts'] as AppPermission[],
      ['storage'] as AppPermission[]
    );
    from({ kind: 'hello', appId: 'probe' });
    const hydrate = posted[0] as Extract<ToFrame, { kind: 'hydrate' }>;
    expect(hydrate.payload.permissions).toEqual(['storage']);
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
      member: 'restoreContact',
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
        // `onAny` because `FACET_MEMBERS` has to allow the name before the facet is built
        // at all (MICA-196). This test is about *which app id the factory is handed*, so
        // what the member is underneath does not matter — a store is simply the shape a
        // `subscribe` needs.
        ((appId?: unknown) => {
          built.push({ facet: 'appEvents', appId });
          return { onAny: writable([]), clear: () => true };
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
      const { posted, from } = server(['storage'] as AppPermission[]);
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
      const { from } = server(['app-events'] as AppPermission[]);
      from({
        kind: 'subscribe',
        id: 2,
        facet: 'appEvents',
        factoryArgs: ['mail'],
        member: 'onAny'
      });
      expect(built).toEqual([{ facet: 'appEvents', appId: 'probe' }]);
    });

    it('pins appAction, and turns notifications(undefined) — every app — into this one', async () => {
      const { from } = server(['notifications'] as AppPermission[]);
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
      const { posted, from } = server(['app-registry'] as AppPermission[]);
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
      const { posted, from } = server(['app-registry'] as AppPermission[]);
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
      const { posted, from } = server(['keybinds-write'] as AppPermission[]);
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
      const { posted, from } = server(['app-registry-write'] as AppPermission[]);
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
      const { posted, from } = server(['notification-settings-write'] as AppPermission[]);
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
        const { posted, from } = server(['system-hardware-write'] as AppPermission[]);
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
        const { posted, from } = server(['system-hardware-write'] as AppPermission[]);
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
   * MICA-196. The prefix rule above is what an add-on that declares nothing still gets,
   * and it cannot tell an app that owns `probe_dms` from one whose id merely prefixes it.
   * A manifest that states `services` gets an exact-match answer instead — narrower, and
   * backed by the registry refusing an install that collides with an installed app's claim.
   */
  it('reads a declared `services` list instead of the prefix rule', async () => {
    registerFacet(
      'service' as any,
      ((id: string) => ({ id, call: () => Promise.resolve('ok') })) as any
    );
    const declaring = defineApp({
      id: 'probe',
      name: 'Probe',
      icon: 'x',
      tile: { bg: 'bg-gray-900' },
      core: false,
      permissions: ['contacts'],
      services: ['probe']
    } as any);
    const posted: ToFrame[] = [];
    const current = { postMessage: (m: ToFrame) => posted.push(m) };
    const s = createIframeHostServer({
      host: createInProcessHost('probe', []),
      manifest: declaring,
      props: {},
      guest: () => current,
      onError: vi.fn(),
      onKey: vi.fn(),
      onTyping: vi.fn()
    });
    const call = (id: number, service: string) =>
      s.handle({
        data: {
          kind: 'call',
          id,
          facet: 'service',
          factoryArgs: [service],
          member: 'call',
          args: []
        },
        source: current,
        origin: 'null'
      } as unknown as MessageEvent);

    call(1, 'probe');
    // Inside the namespace, so the prefix rule would have allowed it — and this manifest
    // did not claim it, which is the whole difference.
    call(2, 'probe_dms');
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

  /**
   * MICA-196. `event.source` cannot tell a navigated guest from the original one — a
   * `WindowProxy` survives navigation, same object, new document — so a frame that sets
   * `location.href = 'https://evil'` goes on satisfying every check the reload work
   * (MICA-90) put in place. The origin is the thing that changes: an opaque srcdoc
   * document posts the literal `'null'`, a real page posts its real origin.
   */
  describe('a guest that navigated away', () => {
    /** A server whose escape hatch is observable, and a hydrated guest to steal. */
    const escaping = () => {
      const onEscape = vi.fn();
      const posted: ToFrame[] = [];
      const current = { postMessage: (m: ToFrame) => posted.push(m) };
      const s = createIframeHostServer({
        host: createInProcessHost('probe', manifest.permissions!),
        manifest,
        props: {},
        guest: () => current,
        onError: vi.fn(),
        onEscape,
        onKey: vi.fn(),
        onTyping: vi.fn()
      });
      const from = (data: unknown, origin = 'null') =>
        s.handle({ data, source: current, origin } as unknown as MessageEvent);
      from({ kind: 'hello', appId: 'probe' });
      posted.length = 0;
      return { s, posted, from, onEscape };
    };

    it('is shut down the first time it posts from a real origin', () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { posted, from, onEscape } = escaping();

      from({ kind: 'hello', appId: 'probe' }, 'https://evil.example');

      expect(posted).toHaveLength(0);
      expect(onEscape).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('navigated itself away'));
      error.mockRestore();
    });

    it('stays shut down: nothing it sends afterwards is answered', () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { posted, from } = escaping();

      from({ kind: 'hello', appId: 'probe' }, 'https://evil.example');
      // Back to an opaque origin — which a navigated document cannot actually produce, but
      // the server must not be recoverable by a guest simply claiming it is opaque again.
      from({ kind: 'hello', appId: 'probe' });
      from({
        kind: 'call',
        id: 1,
        facet: 'contacts',
        factoryArgs: [],
        member: 'addContact',
        args: ['ab']
      });

      expect(posted).toHaveLength(0);
      error.mockRestore();
    });

    /**
     * The shell's own `window.postMessage` traffic — the dev harness's `appEvent`, the
     * NUI router's messages — arrives on this listener too, with the shell's real origin
     * and `window` as its source. Ordinary, and silent: a real-origin message is only an
     * escape when it also comes from the window in this frame.
     */
    it('does not mistake the shell posting to itself for an escape', () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { posted, from, onEscape, s } = escaping();

      s.handle({
        data: { action: 'appEvent', data: {} },
        source: {},
        origin: 'https://cfx-nui-gphone'
      } as unknown as MessageEvent);

      expect(onEscape).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      // And the server is still live for the guest it was built for.
      from({ kind: 'hello', appId: 'probe' });
      expect(posted.filter((m) => m.kind === 'hydrate')).toHaveLength(1);
      error.mockRestore();
    });
  });

  /**
   * MICA-196. None of this was bounded. A `subscribe` entry is a live store listener in
   * the shell, so a resubscribe loop in a frame — a bug as easily as an attack — held
   * thousands of them and kept every store it touched fanning out to a dead sandbox for the
   * life of the page. `instances` is keyed partly on what the frame sent. And `call` had no
   * rate at all, on a channel that reaches real facets and, through `service`, the server.
   */
  describe('per-frame limits', () => {
    const callMsg = (id: number) => ({
      kind: 'call',
      id,
      facet: 'contacts',
      factoryArgs: [],
      member: 'addContact',
      args: ['ab']
    });

    it('answers up to the request budget and refuses past it, rather than going quiet', async () => {
      const { posted, from } = server();
      for (let id = 1; id <= ADDON_LIMITS.requestsPerWindow + 1; id++) from(callMsg(id));
      await new Promise((resolve) => setTimeout(resolve, 0));

      const answered = posted.filter((m) => m.kind === 'reply' && (m as any).ok === true);
      expect(answered).toHaveLength(ADDON_LIMITS.requestsPerWindow);

      // A reply, not silence: the add-on's own `await` rejects and it can say so. A
      // dropped message would leave the promise pending for the life of the frame.
      const refused = posted.find(
        (m) => m.kind === 'reply' && (m as any).id === ADDON_LIMITS.requestsPerWindow + 1
      ) as any;
      expect(refused).toMatchObject({ ok: false });
      expect(refused.error.message).toMatch(/calling the shell too fast/);
    });

    it('counts subscribes against the same budget as calls', async () => {
      // A subscribe/unsubscribe loop never holds more than one live subscription, so the
      // live cap below cannot see it at all — it is a call flood spelled differently, and a
      // budget that only counted `call` would watch it go past.
      const { posted, from } = server();
      for (let id = 1; id <= ADDON_LIMITS.requestsPerWindow; id++) {
        from({
          kind: 'subscribe',
          id,
          facet: 'contacts',
          factoryArgs: [],
          member: 'contactsStore'
        });
        from({ kind: 'unsubscribe', id });
      }
      posted.length = 0;

      from(callMsg(9999));
      await new Promise((resolve) => setTimeout(resolve, 0));

      const refused = posted.find((m) => m.kind === 'reply' && (m as any).id === 9999) as any;
      expect(refused).toMatchObject({ ok: false });
      expect(refused.error.message).toMatch(/calling the shell too fast/);
    });

    it('refuses a subscription past the live cap, and holds no listener for it', () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { posted, from } = server();
      for (let id = 1; id <= ADDON_LIMITS.subscriptions + 1; id++) {
        from({
          kind: 'subscribe',
          id,
          facet: 'contacts',
          factoryArgs: [],
          member: 'contactsStore'
        });
      }
      posted.length = 0;

      // One push per *held* subscription, and the one past the cap holds nothing.
      store.set(2);
      expect(posted.filter((m) => m.kind === 'push')).toHaveLength(ADDON_LIMITS.subscriptions);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining("add-on 'probe' subscribe failed"),
        expect.any(Error)
      );
      error.mockRestore();
    });

    it('refuses a new facet instance past the cap, and keeps the ones already built', async () => {
      registerFacet(
        'service' as any,
        ((id: string) => ({ id, call: () => Promise.resolve('ok') })) as any
      );
      const { posted, from } = server([]);
      // Each id is inside the app's own namespace, so every one of these is a call the
      // service rule allows — the cap is the only thing standing in the way.
      for (let i = 0; i <= ADDON_LIMITS.instances; i++) {
        from({
          kind: 'call',
          id: i + 1,
          facet: 'service',
          factoryArgs: [`probe_${i}`],
          member: 'call',
          args: ['list']
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 0));

      const ok = posted.filter((m) => m.kind === 'reply' && (m as any).ok === true);
      expect(ok).toHaveLength(ADDON_LIMITS.instances);
      const refused = posted.find(
        (m) => m.kind === 'reply' && (m as any).id === ADDON_LIMITS.instances + 1
      ) as any;
      expect(refused.error.message).toMatch(/too many live facet instances/);

      // Refused, not evicted: a cached facet may hold live state on the frame's behalf, so
      // an already-built one must keep working rather than disappear under the add-on.
      posted.length = 0;
      from({
        kind: 'call',
        id: 5000,
        facet: 'service',
        factoryArgs: ['probe_0'],
        member: 'call',
        args: ['list']
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(posted[0]).toMatchObject({ ok: true });
    });
  });

  /**
   * MICA-196. `registerAddOn` refuses a mismatched bundle at install, which is where a
   * player gets a message they can act on. This is the same question asked where the *code*
   * is about to start, for a bundle that reached a frame by a path that never went through
   * an install — a dev registration, or an install from a build before the gate existed.
   */
  describe('a bundle built against a different SDK contract', () => {
    const withContract = (sdkContract: string) =>
      defineApp({
        id: 'probe',
        name: 'Probe',
        icon: 'x',
        tile: { bg: 'bg-gray-900' },
        core: false,
        permissions: ['contacts'],
        sdkContract
      } as any);

    const frameFor = (m: ReturnType<typeof defineApp>) => {
      const onEscape = vi.fn();
      const posted: ToFrame[] = [];
      const current = { postMessage: (msg: ToFrame) => posted.push(msg) };
      const s = createIframeHostServer({
        host: createInProcessHost('probe', ['contacts'] as AppPermission[]),
        manifest: m,
        props: {},
        guest: () => current,
        onError: vi.fn(),
        onEscape,
        onKey: vi.fn(),
        onTyping: vi.fn()
      });
      const hello = () =>
        s.handle({
          data: { kind: 'hello', appId: 'probe' },
          source: current,
          origin: 'null'
        } as unknown as MessageEvent);
      return { posted, hello, onEscape };
    };

    it('never hydrates, so the theme, the storage snapshot and the constants stay inside', () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { posted, hello, onEscape } = frameFor(withContract('99'));

      hello();

      expect(posted).toHaveLength(0);
      expect(onEscape).toHaveBeenCalledWith(expect.stringContaining('SDK contract 99'));
      error.mockRestore();
    });

    it('hydrates a bundle built against this phone’s own contract', () => {
      const { posted, hello, onEscape } = frameFor(withContract(SDK_CONTRACT_VERSION));

      hello();

      expect(posted[0]).toMatchObject({ kind: 'hydrate' });
      expect(onEscape).not.toHaveBeenCalled();
    });

    it('hydrates a manifest that says nothing, which is every add-on published so far', () => {
      // The shared `manifest` at the top of this file declares no `sdkContract`, which is
      // the state a bundle built before the field existed is permanently in.
      expect(manifest.sdkContract).toBeUndefined();
      const { posted, hello, onEscape } = frameFor(manifest);

      hello();

      expect(posted[0]).toMatchObject({ kind: 'hydrate' });
      expect(onEscape).not.toHaveBeenCalled();
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
    const from = (data: unknown) =>
      s.handle({ data, source, origin: 'null' } as unknown as MessageEvent);
    from({ kind: 'error', message: 'boom', stack: null });
    from({ kind: 'typing', typing: true });
    expect(onError).toHaveBeenCalledWith('boom', null);
    expect(onTyping).toHaveBeenCalledWith(true);
  });
});
