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
import { ServiceRefusal, type AppPermission } from '@mica/sdk';
import { describe, it, expect, vi, beforeEach, afterEach, onTestFinished } from 'vitest';
import { get, writable } from 'svelte/store';
import { createInProcessHost } from '../../../../sdk/host/inProcess/createInProcessHost';
import { registerFacet, resetHostsForTest } from '../../../../sdk/host/current';
import { ADDON_HELLO_TIMEOUT_MS, ADDON_LIMITS, createIframeHostServer } from './IframeHostServer';
import { defineApp } from '../../../../sdk/manifest';
import {
  DENIED_FACETS,
  MEMBER_APP_ARGS,
  permissionOfFacet,
  type AppIdArg,
  type UnpinnedAppIdArg
} from '../../../../sdk/permissions';
import { SDK_CONTRACT_VERSION } from '../../../../sdk/version';
import { is24Hour as shellIs24Hour } from '../state/time';
import { recordConsent, resetGrantsForTest } from '../state/addOnGrants';
import { pushStorageToAddOns, __resetSettingsSync } from '../../host/settingsSync';
import { lifecycle } from '../../host/facets/lifecycle';
import { keybinds } from '../../host/facets/keybinds';
import { phoneNotification } from '../../host/facets/phoneNotification';
import { activeHandlerFor } from '../state/keybinds';
import { toast as shellToast } from '../state/toast';
import { currentApp as shellCurrentApp } from '../state/navigation';
import { shadeNotifications } from '../../services/notifications';
import { dndEnabled } from '../state/notificationPolicy';
import type { ToFrame } from '../../../../sdk/host/iframe/messages';
import Skeleton from '../../../../sdk/ui/Skeleton.svelte';
import '../../../../sdk/host/useContacts';
import '../../../../sdk/host/useDisplay';
import '../../../../sdk/host/useWallpaper';
import '../../../../sdk/host/useSystemHardware';
import '../../../../sdk/host/useTheme';

/** A namespaced storage key. Built, not quoted: a `mica:` literal reads as a net event to `server/__tests__/eventNames.test.ts`. */
const storageKey = (app: string, key: string) => `mica:${app}:${key}`;

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
  // Cloned, the way a real `postMessage` clones: a function, a symbol or a Proxy in a
  // message throws `DataCloneError` here exactly where it would in the browser.
  const makeWindow = () => ({ postMessage: (m: ToFrame) => posted.push(structuredClone(m)) });
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
  // Every `server()` in this file that reaches `hello` registers a real, module-scope
  // `pushStorageToAddOns` callback (MICA-287) — most never call `dispose()`, since that
  // is not what they are testing, so this is what keeps that registry from growing one
  // stale entry per test for the rest of the file.
  __resetSettingsSync();
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
  it('hydrate storage keeps the full mica:<appId>:<key>, not stripped of its prefix', () => {
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
      registerFacet(
        'searchProvider' as any,
        ((appId?: unknown) => {
          built.push({ facet: 'searchProvider', appId });
          return { query: writable(''), publish: () => true };
        }) as any
      );
      registerFacet(
        'directMessages' as any,
        ((appId?: unknown) => {
          built.push({ facet: 'directMessages', appId });
          return { threads: () => [], thread: () => ({ rows: [], nextCursor: null }) };
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

    /**
     * MICA-286, and the reason this test names the facet rather than trusting the set.
     *
     * `APP_SCOPED_FACETS` is a list, and a facet that takes an app id but is left off it
     * fails open: everything works, and one add-on can publish search rows under another
     * app's name. The tests above prove the *mechanism* pins whatever is in the set; this
     * one proves `searchProvider` is in it, so deleting that entry turns something red.
     */
    it('pins a search provider, so an add-on cannot publish hits under another app', async () => {
      const { from } = server(['search'] as AppPermission[]);
      from({
        kind: 'call',
        id: 5,
        facet: 'searchProvider',
        factoryArgs: ['notes'],
        member: 'publish',
        args: ['ren', [{ id: 1, title: 'not mine' }]]
      });
      await Promise.resolve();
      await Promise.resolve();

      // Not 'notes' — the frame said so, and saying so is not being so.
      expect(built).toEqual([{ facet: 'searchProvider', appId: 'probe' }]);
    });

    /**
     * MICA-433: a provider is handed every keystroke of the player's query, so it is a
     * declared, consented permission now, not an implicit one. Neither the query nor the
     * publish is answered without it, and the facet is never built.
     */
    it('refuses a search provider the add-on did not declare, or the player did not grant', async () => {
      for (const [declared, granted] of [
        [[], []],
        [['search'], []]
      ] as AppPermission[][][]) {
        const { posted, from } = server(declared, granted);
        from({
          kind: 'call',
          id: 5,
          facet: 'searchProvider',
          factoryArgs: ['probe'],
          member: 'publish',
          args: ['ren', []]
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(posted).toContainEqual(
          expect.objectContaining({
            kind: 'reply',
            id: 5,
            ok: false,
            error: expect.objectContaining({ permission: 'search', hookName: 'useSearchProvider' })
          })
        );
      }
      expect(built).toEqual([]);
    });

    /**
     * MICA-390, for the same reason as the search provider above: proves `directMessages`
     * is in the set, so an add-on with `social` reads its own app's DMs and nobody else's.
     * Both a read and the paged thread, since either left unpinned is a private-message leak.
     */
    it("pins direct messages, so an add-on cannot read another app's DMs", async () => {
      const { posted, from } = server(['social'] as AppPermission[]);
      from({
        kind: 'call',
        id: 6,
        facet: 'directMessages',
        factoryArgs: ['blabber'],
        member: 'threads',
        args: []
      });
      from({
        kind: 'call',
        id: 7,
        facet: 'directMessages',
        factoryArgs: ['blabber'],
        member: 'thread',
        args: [{ account_id: 1, peer_account_id: 2 }]
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(posted.filter((m: any) => m.kind === 'reply' && m.ok)).toHaveLength(2);
      // Not 'blabber' — the frame named Blabber's inbox and was handed its own. Built once:
      // both calls reach the one instance the pinned arguments name.
      expect(built).toEqual([{ facet: 'directMessages', appId: 'probe' }]);
    });

    it('refuses direct messages to an add-on without the social permission', async () => {
      const { posted, from } = server([] as AppPermission[]);
      from({
        kind: 'call',
        id: 8,
        facet: 'directMessages',
        factoryArgs: ['probe'],
        member: 'threads',
        args: []
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(posted[posted.length - 1]).toMatchObject({ kind: 'reply', id: 8, ok: false });
      expect(built).toEqual([]);
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
   * A push is made from inside the store's own subscriber, and Svelte runs every store's
   * subscribers off one shared queue. A value `postMessage` cannot clone used to throw out of
   * that queue and leave it full, so no store in the bundle notified anyone again. Registry
   * manifests carry `icon` components and toasts carry `onClick`, so this was every change.
   */
  describe('pushed store values', () => {
    let registry = writable<unknown>([]);

    beforeEach(() => {
      registry = writable<unknown>([{ id: 'probe', icon: Skeleton, open: () => {} }]);
      registerFacet(
        'appRegistry' as any,
        (() => ({
          registryStore: registry,
          getFirstBootTime: () => 7,
          unregisterApp: () => true,
          installFromCatalog: () => true
        })) as any
      );
    });

    const subscribeRegistry = (from: (data: unknown) => void) =>
      from({
        kind: 'subscribe',
        id: 2,
        facet: 'appRegistry',
        factoryArgs: [],
        member: 'registryStore'
      });

    it('sends a value carrying a function and a component as data, without them', () => {
      const { posted, from } = server(['app-registry'] as AppPermission[]);
      subscribeRegistry(from);
      expect(posted[posted.length - 1]).toEqual({ kind: 'push', id: 2, value: [{ id: 'probe' }] });
    });

    it('leaves every other subscriber, of this store and of any other, still notified', () => {
      const { posted, from } = server(['app-registry'] as AppPermission[]);
      subscribeRegistry(from);
      // Subscribed after the frame, so it runs after the frame's push in the same loop.
      const sameStore: unknown[] = [];
      const offSame = registry.subscribe((v) => sameStore.push(v));
      const elsewhere = writable(0);
      const otherStore: number[] = [];
      const offOther = elsewhere.subscribe((v) => otherStore.push(v));

      const next = [
        { id: 'probe', icon: Skeleton, open: () => {} },
        { id: 'mail', icon: Skeleton, open: () => {} }
      ];
      registry.set(next);
      elsewhere.set(1);

      expect(sameStore).toHaveLength(2);
      expect(sameStore[1]).toBe(next);
      expect(otherStore).toEqual([0, 1]);
      expect(posted[posted.length - 1]).toEqual({
        kind: 'push',
        id: 2,
        value: [{ id: 'probe' }, { id: 'mail' }]
      });
      offSame();
      offOther();
    });

    it('keeps a Date, a Map, a Set and a shared reference, and turns an Error into its name and message', () => {
      const { posted, from } = server(['app-registry'] as AppPermission[]);
      subscribeRegistry(from);
      const shared = { n: 1, run: () => {} };
      const error = new TypeError('nope');
      registry.set({
        when: new Date(0),
        byId: new Map<unknown, unknown>([
          ['a', shared],
          ['b', () => {}]
        ]),
        tags: new Set<unknown>(['x', Symbol('y')]),
        list: [1, () => {}, 3],
        again: shared,
        error
      });

      const push = posted[posted.length - 1] as Extract<ToFrame, { kind: 'push' }>;
      const value = push.value as Record<string, any>;
      expect(value.when).toEqual(new Date(0));
      expect(value.byId).toEqual(new Map([['a', { n: 1 }]]));
      expect(value.tags).toEqual(new Set(['x']));
      expect(value.list).toEqual([1, undefined, 3]);
      expect(value.again).toBe(value.byId.get('a'));
      expect(value.error).toEqual({ name: 'TypeError', message: 'nope' });
      expect(value.error).not.toBeInstanceOf(Error);
    });

    it('sends an own __proto__ key as a plain key, and re-parents nothing', () => {
      const { posted, from } = server(['app-registry'] as AppPermission[]);
      subscribeRegistry(from);
      // What a JSON-parsed deep-link prop looks like: an own data property, not the accessor.
      registry.set(JSON.parse('{"a":1,"__proto__":{"polluted":true}}'));

      const push = posted[posted.length - 1] as Extract<ToFrame, { kind: 'push' }>;
      const value = push.value as Record<string, unknown>;
      expect(Object.keys(value)).toEqual(['a', '__proto__']);
      expect(Object.getOwnPropertyDescriptor(value, '__proto__')?.value).toEqual({
        polluted: true
      });
      expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
      expect((value as { polluted?: unknown }).polluted).toBeUndefined();
    });

    it('logs a push that still cannot cross once, and keeps the store loop running', () => {
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { posted, from } = server(['app-registry'] as AppPermission[]);
      subscribeRegistry(from);
      const before = posted.length;
      const throwing = () => ({
        get boom(): never {
          throw new Error('getter');
        }
      });
      const sameStore: unknown[] = [];
      const off = registry.subscribe((v) => sameStore.push(v));

      registry.set(throwing());
      registry.set(throwing());

      expect(posted).toHaveLength(before);
      expect(sameStore).toHaveLength(3);
      expect(errors.mock.calls.filter(([m]) => String(m).includes('push of'))).toHaveLength(1);
      off();
      errors.mockRestore();
    });
  });

  /**
   * The facet took no app id. An add-on's notice went in the drawer under `'system'`, or
   * `'messages'` given `type: 'message'`; `toast` streamed every app's toasts to it, message
   * text and all; and `dismissNotification` took down any id. The real facet and the real
   * toast store, so the pin is proven where it is made.
   */
  describe('phoneNotification is pinned to the frame', () => {
    const flush = async () => {
      await Promise.resolve();
      await Promise.resolve();
    };
    const call = (id: number, member: string, args: unknown[]) => ({
      kind: 'call',
      id,
      facet: 'phoneNotification',
      // Names another app, which is exactly what must not matter.
      factoryArgs: ['messages'],
      member,
      args
    });
    const replyTo = (posted: ToFrame[], id: number) =>
      posted.find((m) => m.kind === 'reply' && m.id === id) as Extract<ToFrame, { kind: 'reply' }>;

    beforeEach(() => {
      registerFacet('phoneNotification', phoneNotification);
      shellToast.clear();
      shadeNotifications.set([]);
    });

    afterEach(() => {
      shellToast.clear();
      shadeNotifications.set([]);
    });

    it('files a notice under the add-on, whatever app the frame names and whatever its type', async () => {
      const { posted, from } = server(['notifications'] as AppPermission[]);
      from(call(1, 'sendNotification', [{ title: 'Probe', message: 'hi', type: 'message' }]));
      await flush();

      expect(replyTo(posted, 1)).toMatchObject({ ok: true });
      expect(get(shellToast)).toMatchObject([
        { app: 'probe', title: 'Probe', message: 'hi', type: 'info' }
      ]);
      // The drawer row too: not 'messages', which `type: 'message'` used to pick, nor 'system'.
      expect(get(shadeNotifications).map((n) => n.app)).toEqual(['probe']);
    });

    it("never pushes another app's toast to the frame, and pushes its own", async () => {
      const { posted, from } = server(['notifications'] as AppPermission[]);
      from({
        kind: 'subscribe',
        id: 2,
        facet: 'phoneNotification',
        factoryArgs: ['messages'],
        member: 'toast'
      });
      expect(posted[posted.length - 1]).toEqual({ kind: 'push', id: 2, value: [] });
      const pushes = () => posted.filter((m) => m.kind === 'push' && m.id === 2);

      const foreign = shellToast.show({ app: 'messages', title: 'Ann', message: 'secret text' });
      shellToast.dismiss(foreign);
      // Not even an empty list: that alone would say some app just notified, and when.
      expect(pushes()).toHaveLength(1);

      from(call(3, 'sendNotification', [{ message: 'mine' }]));
      await flush();

      expect(pushes()).toHaveLength(2);
      expect(pushes()[1]).toMatchObject({ value: [{ app: 'probe', message: 'mine' }] });
      expect(JSON.stringify(posted)).not.toContain('secret text');
    });

    it("refuses to dismiss another app's toast, and dismisses its own", async () => {
      const { posted, from } = server(['notifications'] as AppPermission[]);
      const foreign = shellToast.show({ app: 'messages', message: 'still here' });

      from(call(4, 'dismissNotification', [foreign]));
      await flush();
      expect(replyTo(posted, 4)).toMatchObject({
        ok: false,
        error: { message: expect.stringContaining('own notifications') }
      });
      expect(get(shellToast).map((t) => t.id)).toEqual([foreign]);

      // Its own notice queues behind the visible one; dismissing it takes it out of line.
      from(call(5, 'sendNotification', [{ message: 'mine' }]));
      await flush();
      const own = (replyTo(posted, 5) as { value: string }).value;
      from(call(6, 'dismissNotification', [own]));
      await flush();
      expect(replyTo(posted, 6)).toMatchObject({ ok: true });
      shellToast.dismiss(foreign);
      expect(get(shellToast)).toEqual([]);
    });

    it('scopes a core app the same way in-process', () => {
      const bank = phoneNotification('bank');
      const seen: unknown[][] = [];
      const off = bank.toast.subscribe((list) => seen.push(list.map((t) => t.app)));

      shellToast.show({ app: 'messages', message: 'not the bank' });
      expect(seen).toEqual([[]]);
      shellToast.clear();

      bank.sendNotification({ message: 'sent', type: 'message' });
      expect(seen).toEqual([[], ['bank']]);
      expect(get(shadeNotifications).map((n) => n.app)).toEqual(['bank', 'messages']);
      off();
    });

    /**
     * A `call` jumps the banner on screen, is never dropped from the queue, never expires at
     * `duration: 0`, and stops the ringtone when it goes, which silenced a real call waiting
     * behind it. Only the shell's own `showCall` makes one.
     */
    it("sends a frame's 'call' as an info notice, in line behind what is on screen", async () => {
      const { posted, from } = server(['notifications'] as AppPermission[]);
      const visible = shellToast.show({ app: 'messages', title: 'Ann', message: 'first' });

      from(
        call(7, 'sendNotification', [{ title: 'Ring', message: 'x', type: 'call', duration: 0 }])
      );
      await flush();
      const notice = (replyTo(posted, 7) as { value: string }).value;

      expect(get(shellToast).map((t) => t.id)).toEqual([visible]);
      shellToast.dismiss(visible);
      expect(get(shellToast)).toMatchObject([{ id: notice, app: 'probe', type: 'info' }]);
    });

    it('holds the banner under Do Not Disturb, and still writes the drawer row', async () => {
      dndEnabled.set(true);
      onTestFinished(() => dndEnabled.set(false));
      const { posted, from } = server(['notifications'] as AppPermission[]);

      from(call(8, 'sendNotification', [{ title: 'Probe', message: 'quiet please' }]));
      await flush();

      expect(replyTo(posted, 8)).toMatchObject({ ok: true });
      expect(get(shellToast)).toEqual([]);
      expect(get(shadeNotifications)).toMatchObject([{ app: 'probe', body: 'quiet please' }]);
    });

    /**
     * Ownership is read off the toast's record. It was parsed out of the id, `notice:<app>:`,
     * so an app whose id began `probe:` (nothing refuses one outside DEV) had notices this
     * frame could take down.
     */
    it("refuses a notice of an app whose id merely starts with the frame's, and ignores a gone id", async () => {
      const { posted, from } = server(['notifications'] as AppPermission[]);
      const lookalike = phoneNotification('probe:x').sendNotification({ message: 'not yours' });

      from(call(9, 'dismissNotification', [lookalike]));
      await flush();
      expect(replyTo(posted, 9)).toMatchObject({ ok: false });
      expect(get(shellToast).map((t) => t.id)).toEqual([lookalike]);

      // An id with no toast behind it has nothing to take down, and is not an error.
      from(call(10, 'dismissNotification', ['notice:probe:999999']));
      await flush();
      expect(replyTo(posted, 10)).toMatchObject({ ok: true });
      expect(get(shellToast).map((t) => t.id)).toEqual([lookalike]);
    });

    /**
     * Only one toast shows at a time, so a notice that never expired held every banner
     * behind it until the player swiped it away. `duration: 0` was exactly that.
     */
    it("expires a frame's notice at zero duration, and cuts a long one to the ceiling", async () => {
      const { posted, from } = server(['notifications'] as AppPermission[]);
      // After the server, so its hello watchdog keeps a real timer and stays out of this.
      vi.useFakeTimers();
      onTestFinished(() => {
        vi.useRealTimers();
      });

      from(call(11, 'sendNotification', [{ message: 'sticky', duration: 0 }]));
      await flush();
      expect(replyTo(posted, 11)).toMatchObject({ ok: true });
      expect(get(shellToast)).toMatchObject([{ message: 'sticky', duration: 4500 }]);
      vi.advanceTimersByTime(4500);
      expect(get(shellToast)).toEqual([]);

      from(call(12, 'sendNotification', [{ message: 'long', duration: 600_000 }]));
      await flush();
      expect(get(shellToast)).toMatchObject([{ message: 'long', duration: 10_000 }]);
      vi.advanceTimersByTime(10_000);
      expect(get(shellToast)).toEqual([]);
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

    /**
     * MICA-237. The relayed catalog makes the server fetch a URL for whoever asks, so an
     * add-on able to name it could make the shell's server spend that on its behalf. Core only,
     * like every other member of this facet.
     */
    it('refuses fetchRemoteCatalog to an add-on, even with app-registry-write granted', async () => {
      const fetchRemoteCatalog = vi.fn();
      registerFacet('appRegistryWrite' as any, (() => ({ fetchRemoteCatalog })) as any);
      const { posted, from } = server(['app-registry-write'] as AppPermission[]);
      from({
        kind: 'call',
        id: 1,
        facet: 'appRegistryWrite',
        factoryArgs: [],
        member: 'fetchRemoteCatalog',
        args: []
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(posted[0]).toMatchObject({
        ok: false,
        error: { message: expect.stringContaining('core only') }
      });
      expect(fetchRemoteCatalog).not.toHaveBeenCalled();
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
   * MICA-310. A `ServiceRefusal` crosses with its key, so the frame can rebuild one; any
   * other error crosses as a name and a message, whatever else is hanging off it.
   */
  it('posts a refusal’s key and nothing else of any error', async () => {
    const leaky = Object.assign(new Error('plain'), {
      key: 'server.jobs.lineUnavailable',
      cause: new Error('SELECT * FROM phone_secrets'),
      sql: 'SELECT 1'
    });
    const failures: Record<string, Error> = {
      refused: new ServiceRefusal('server.rateLimited', 'Slow down.'),
      leaky
    };
    registerFacet(
      'service' as any,
      ((id: string) => ({
        id,
        call: (action: string) => Promise.reject(failures[action])
      })) as any
    );
    const { posted, from } = server([]);
    for (const [id, action] of [
      [1, 'refused'],
      [2, 'leaky']
    ] as const) {
      from({
        kind: 'call',
        id,
        facet: 'service',
        factoryArgs: ['probe'],
        member: 'call',
        args: [action]
      });
    }
    for (let i = 0; i < 10 && posted.length < 2; i++) await Promise.resolve();

    const byId = (id: number) =>
      posted.find((m) => m.kind === 'reply' && m.id === id) as Extract<
        ToFrame,
        { kind: 'reply'; ok: false }
      >;
    expect(byId(1).error).toEqual({
      name: 'ServiceRefusal',
      message: 'Slow down.',
      key: 'server.rateLimited'
    });
    expect(byId(2).error).toEqual({ name: 'Error', message: 'plain' });
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
          },
          // Visible only for the frame's own id, so the pin shows in the value pushed.
          visible: writable(appId === 'probe')
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

    /**
     * `lifecycle` needs no permission, so this is every add-on's view of `currentApp`. It
     * used to be the shell's store, so each app the player opened, and its deep-link props,
     * reached every add-on, in front or not. The real facet over the real store here; a stub
     * emitting the frame's own id is how the old test passed.
     */
    it('subscribes currentApp with no permission, and learns nothing about another app in front', () => {
      registerFacet('lifecycle' as any, lifecycle as any);
      onTestFinished(() => shellCurrentApp.set({ id: 'home', props: {} }));
      shellCurrentApp.set({ id: 'mail', props: { thread: 'secret-thread' } });
      const { posted, from } = server([]);
      // Naming the app in front, which must not matter.
      from({
        kind: 'subscribe',
        id: 1,
        facet: 'lifecycle',
        factoryArgs: ['mail'],
        member: 'currentApp'
      });
      const away = { id: '', props: {} };
      expect(posted).toEqual([{ kind: 'push', id: 1, value: away }]);

      // Another app, then home: still away, so nothing is sent at all.
      shellCurrentApp.set({ id: 'notes', props: { noteId: 3 } });
      shellCurrentApp.set({ id: 'home', props: {} });
      expect(posted).toHaveLength(1);

      // Its own turn in front arrives whole, props included, and leaving it is one push.
      shellCurrentApp.set({ id: 'probe', props: { from: 'link' } });
      shellCurrentApp.set({ id: 'mail', props: { thread: 'other-thread' } });
      expect(posted).toEqual([
        { kind: 'push', id: 1, value: away },
        { kind: 'push', id: 1, value: { id: 'probe', props: { from: 'link' } } },
        { kind: 'push', id: 1, value: away }
      ]);
      expect(JSON.stringify(posted)).not.toMatch(/mail|notes|home|thread|noteId/);
    });

    it("subscribes visible (useAppVisible, MICA-294) with no permission, for the frame's own id only", () => {
      const { posted, from } = server([]);
      // Naming another app does not get the frame that app's answer.
      from({
        kind: 'subscribe',
        id: 1,
        facet: 'lifecycle',
        factoryArgs: ['mail'],
        member: 'visible'
      });
      expect(posted[0]).toEqual({ kind: 'push', id: 1, value: true });
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
   * A frame that never says `hello` used to stay blank until the player closed the app: a
   * bundle that never calls `bootAddOn`, or hangs before it. (One that throws is reported
   * by `srcdocFor`'s fallback `error` listener and was never silent.) The watchdog turns
   * that silence into the ordinary `onError` crash path.
   */
  describe('the startup watchdog', () => {
    const hello = { kind: 'hello', appId: 'probe' };
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    /** `server()` with its `onError` in hand, built after the fake clock is installed. */
    function watched() {
      recordConsent('probe', manifest.permissions!);
      const posted: ToFrame[] = [];
      const makeWindow = () => ({ postMessage: (m: ToFrame) => posted.push(m) });
      let current = makeWindow();
      const onError = vi.fn();
      const s = createIframeHostServer({
        host: createInProcessHost('probe', manifest.permissions!),
        manifest,
        props: {},
        guest: () => current,
        onError,
        onKey: vi.fn(),
        onTyping: vi.fn()
      });
      const from = (data: unknown, source: unknown = current) =>
        s.handle({ data, source, origin: 'null' } as MessageEvent);
      const reload = () => (current = makeWindow());
      return { posted, from, s, onError, reload };
    }

    it('reports a frame that never says hello as a crash, once, when the window closes', () => {
      const { onError } = watched();

      vi.advanceTimersByTime(ADDON_HELLO_TIMEOUT_MS - 1);
      expect(onError).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);

      expect(onError).toHaveBeenCalledOnce();
      expect(onError).toHaveBeenCalledWith(expect.stringContaining('never started'), null);
      vi.advanceTimersByTime(ADDON_HELLO_TIMEOUT_MS * 2);
      expect(onError).toHaveBeenCalledOnce();
    });

    it('stops answering once it has fired, so a hello after the crash screen gets nothing', () => {
      const { posted, from } = watched();
      vi.advanceTimersByTime(ADDON_HELLO_TIMEOUT_MS);

      from(hello);

      expect(posted).toEqual([]);
    });

    it('is satisfied by an accepted hello, and stays quiet after it', () => {
      const { from, onError } = watched();
      vi.advanceTimersByTime(ADDON_HELLO_TIMEOUT_MS - 1);
      const pending = vi.getTimerCount();
      from(hello);
      expect(vi.getTimerCount()).toBe(pending - 1);

      vi.advanceTimersByTime(ADDON_HELLO_TIMEOUT_MS * 2);

      expect(onError).not.toHaveBeenCalled();
    });

    it('is not satisfied by a hello it refused, from the wrong id or the wrong window', () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const { from, onError } = watched();
      from({ kind: 'hello', appId: 'someone-else' });
      from(hello, { postMessage: () => {} });

      vi.advanceTimersByTime(ADDON_HELLO_TIMEOUT_MS);

      expect(onError).toHaveBeenCalledOnce();
    });

    it('is cleared by dispose, so a frame torn down before it started is not called crashed', () => {
      const { s, onError } = watched();
      // Relative, not zero: seeding the grant queues a debounced save of its own.
      const pending = vi.getTimerCount();
      s.dispose();

      expect(vi.getTimerCount()).toBe(pending - 1);
      vi.advanceTimersByTime(ADDON_HELLO_TIMEOUT_MS);
      expect(onError).not.toHaveBeenCalled();
    });

    it('does not restart for a reloaded frame', () => {
      const { from, onError, reload } = watched();
      from(hello);
      // A second hello from a new window in the same frame: the reload path, not a fresh start.
      from(hello, reload());

      vi.advanceTimersByTime(ADDON_HELLO_TIMEOUT_MS);

      expect(onError).not.toHaveBeenCalled();
    });
  });

  /**
   * What a guest started is finished with the guest, not left running behind it.
   *
   * A `call` that registers a callback in the shell (`lifecycle.onBack`, `keybinds.onKeybind`,
   * `appEvents.on`) hands the frame a release handle, and the frame releases it by `invoke`.
   * A frame that crashes, reloads or is torn down never sends that `invoke` — so the server
   * has to, or the registration outlives the document that made it. A reply or a callback
   * that settles after its document is gone must not reach the next one either: ids restart
   * from 1 in a new document, so a stale `reply id: 1` resolves the wrong `await`.
   */
  describe('in-flight work when the guest goes away', () => {
    const hello = { kind: 'hello', appId: 'probe' };

    /** A stand-in `contacts` whose callback-taking member records what is still live. */
    function liveRegistrations() {
      const live = new Set<(n: number) => void>();
      let settle: (v: unknown) => void = () => {};
      registerFacet(
        'contacts' as any,
        (() => ({
          contactsStore: store,
          // Registers and returns its release — the `onBack` shape.
          restoreContact: (cb: (n: number) => void) => {
            live.add(cb);
            return () => live.delete(cb);
          },
          // Registers and returns nothing — a callback the shell keeps firing at will.
          shareContact: (cb: (n: number) => void) => {
            live.add(cb);
          },
          // Settles whenever the test says so — a slow NUI round trip.
          addContact: () => new Promise((resolve) => (settle = resolve))
        })) as any
      );
      return { live, settle: (v: unknown) => settle(v) };
    }

    const register = (id: number, cb: number, member = 'restoreContact') => ({
      kind: 'call',
      id,
      facet: 'contacts',
      factoryArgs: [],
      member,
      args: [{ __cb: cb }]
    });
    const flush = async () => {
      for (let i = 0; i < 4; i++) await Promise.resolve();
    };

    it('releases a registration the frame never released, on dispose', async () => {
      const { live } = liveRegistrations();
      const { from, s } = server();
      from(hello);
      from(register(1, 7));
      await flush();
      expect(live.size).toBe(1);

      s.dispose();

      expect(live.size).toBe(0);
    });

    it('releases the previous document’s registrations when a reloaded frame says hello', async () => {
      const { live } = liveRegistrations();
      const { from, reload } = server();
      from(hello);
      from(register(1, 7));
      await flush();

      from(hello, reload());

      expect(live.size).toBe(0);
    });

    it('takes a dead add-on’s Back handler off the real keybind stack', async () => {
      // The user-visible half: with the release dropped, the stale handler stays the active
      // `back` for this app id, so Back on the crash screen fires into a frame that is gone.
      registerFacet('lifecycle' as any, lifecycle as any);
      const { from, s } = server([]);
      from(hello);
      from({
        kind: 'call',
        id: 1,
        facet: 'lifecycle',
        factoryArgs: ['probe'],
        member: 'onBack',
        args: [{ __cb: 3 }]
      });
      await flush();
      expect(activeHandlerFor('back', 'probe')).toBeDefined();

      s.dispose();

      expect(activeHandlerFor('back', 'probe')).toBeUndefined();
    });

    it('does not post a reply that settles after a reload to the new document, and releases it', async () => {
      const { settle } = liveRegistrations();
      const { posted, from, reload } = server();
      from(hello);
      from({
        kind: 'call',
        id: 1,
        facet: 'contacts',
        factoryArgs: [],
        member: 'addContact',
        args: []
      });
      await flush();

      from(hello, reload());
      posted.length = 0;
      const release = vi.fn();
      settle(release);
      await flush();

      // The new document's own call 1 would take this as its answer.
      expect(posted.filter((m) => m.kind === 'reply')).toEqual([]);
      expect(release).toHaveBeenCalledOnce();
    });

    it('releases a registration whose reply settles after dispose', async () => {
      const { settle } = liveRegistrations();
      const { posted, from, s } = server();
      from(hello);
      from({
        kind: 'call',
        id: 1,
        facet: 'contacts',
        factoryArgs: [],
        member: 'addContact',
        args: []
      });
      await flush();

      s.dispose();
      posted.length = 0;
      const release = vi.fn();
      settle(release);
      await flush();

      expect(posted).toEqual([]);
      expect(release).toHaveBeenCalledOnce();
    });

    it('does not fire the previous document’s callbacks into the new one', async () => {
      const { live } = liveRegistrations();
      const { posted, from, reload } = server();
      from(hello);
      from(register(1, 1, 'shareContact'));
      await flush();

      from(hello, reload());
      posted.length = 0;
      for (const cb of live) cb(99);

      // Callback ids restart in the new document too: `cb: 1` would run its handler.
      expect(posted.filter((m) => m.kind === 'callback')).toEqual([]);
    });

    it('still releases a handle exactly once when the frame already invoked it', async () => {
      let releases = 0;
      registerFacet(
        'contacts' as any,
        (() => ({ restoreContact: () => () => (releases += 1) })) as any
      );
      const { posted, from, s } = server();
      from(hello);
      from(register(1, 7));
      await flush();
      const reply = posted.find((m) => m.kind === 'reply') as any;
      from({ kind: 'invoke', handle: reply.value.__fn, args: [] });

      s.dispose();

      expect(releases).toBe(1);
    });
  });

  /**
   * An app id passed as a *call argument* is pinned the same way a factory argument is.
   *
   * `APP_SCOPED_FACETS` only ever rewrote `factoryArgs[0]`. `keybinds.onKeybind` takes its
   * owner as its third argument, so a raw `call` could register `back` under another app's
   * id, or under none. An unscoped handler is the active one whatever app is in front, so a
   * resident add-on took Back away from every app on the phone. `notifications.clearAll`,
   * `highscores.submitScore` and the `accounts` members carry an app id the same way.
   */
  describe('app ids in call arguments are pinned to the calling app', () => {
    /** Every argument list each stub member was called with, keyed `facet.member`. */
    let seen: Record<string, unknown[][]>;
    const record =
      (key: string) =>
      (...args: unknown[]) => {
        (seen[key] ??= []).push(args);
        return key === 'keybinds.onKeybind' ? () => {} : undefined;
      };
    const flush = async () => {
      for (let i = 0; i < 4; i++) await Promise.resolve();
    };

    beforeEach(() => {
      seen = {};
      registerFacet(
        'keybinds' as any,
        (() => ({ onKeybind: record('keybinds.onKeybind') })) as any
      );
      registerFacet(
        'notifications' as any,
        (() => ({ clearAll: record('notifications.clearAll') })) as any
      );
      registerFacet(
        'highscores' as any,
        (() => ({
          submitScore: record('highscores.submitScore'),
          getLeaderboard: record('highscores.getLeaderboard')
        })) as any
      );
      registerFacet(
        'accounts' as any,
        (() =>
          Object.fromEntries(
            [
              'getMyAccounts',
              'getAccounts',
              'createAccount',
              'getFollowStats',
              'getFollowers',
              'getFollowing',
              'searchAccounts',
              'followAccount',
              'unfollowAccount',
              'blockAccount',
              'unblockAccount',
              'getReactionsFor',
              'reactToTarget',
              'unreactToTarget'
            ].map((m) => [m, record(`accounts.${m}`)])
          )) as any
      );
    });

    const PERMS: AppPermission[] = ['keybinds', 'notifications', 'highscores', 'social'];
    const call = (facet: string, member: string, args: unknown[]) => ({
      kind: 'call',
      id: 1,
      facet,
      factoryArgs: [],
      member,
      args
    });

    it('scopes onKeybind to the frame, whether the frame named another app or none', async () => {
      const { from } = server(PERMS);
      from(call('keybinds', 'onKeybind', ['back', { __cb: 1 }, 'settings']));
      from(call('keybinds', 'onKeybind', ['back', { __cb: 2 }]));
      from(call('keybinds', 'onKeybind', ['back', { __cb: 3 }, undefined]));
      await flush();

      expect(seen['keybinds.onKeybind'].map((a) => a[2])).toEqual(['probe', 'probe', 'probe']);
      // The action and the handler are the frame's to choose, and pass through untouched.
      expect(seen['keybinds.onKeybind'].map((a) => a[0])).toEqual(['back', 'back', 'back']);
      expect(typeof seen['keybinds.onKeybind'][0][1]).toBe('function');
    });

    it('leaves the real Back stack with no handler for any app but the frame', async () => {
      registerFacet('keybinds' as any, keybinds as any);
      const { from, s } = server(PERMS);
      from(call('keybinds', 'onKeybind', ['back', { __cb: 1 }]));
      from(call('keybinds', 'onKeybind', ['back', { __cb: 2 }, 'settings']));
      await flush();

      expect(activeHandlerFor('back', 'probe')).toBeDefined();
      expect(activeHandlerFor('back', 'settings')).toBeUndefined();
      expect(activeHandlerFor('back', 'home')).toBeUndefined();
      s.dispose();
    });

    it('clears only the frame’s own notifications, whatever id it sent', async () => {
      const { from } = server(PERMS);
      from(call('notifications', 'clearAll', ['messages']));
      from(call('notifications', 'clearAll', []));
      from(call('notifications', 'clearAll', ['']));
      await flush();

      expect(seen['notifications.clearAll'].map((a) => a[0])).toEqual(['probe', 'probe', 'probe']);
    });

    it('submits a score to the frame’s own leaderboard, and still reads any', async () => {
      const { from } = server(PERMS);
      from(call('highscores', 'submitScore', ['snek', 999]));
      from(call('highscores', 'getLeaderboard', ['snek']));
      await flush();

      expect(seen['highscores.submitScore']).toEqual([['probe', 999]]);
      // A leaderboard is public to every player on the server: reading another game's is
      // what a games hub would do, and discloses nothing a player could not already see.
      expect(seen['highscores.getLeaderboard']).toEqual([['snek']]);
    });

    it('acts in the frame’s own account namespace, never another app’s', async () => {
      const { from } = server(PERMS);
      from(call('accounts', 'getMyAccounts', ['blabber']));
      from(call('accounts', 'createAccount', [{ app: 'blabber', handle: 'ada' }]));
      from(call('accounts', 'followAccount', [{ follower_account_id: 1, followee_account_id: 2 }]));
      from(
        call('accounts', 'getReactionsFor', [
          { app: 'blabber', target_table: 't', target_ids: [1] }
        ])
      );
      await flush();

      expect(seen['accounts.getMyAccounts']).toEqual([['probe']]);
      expect(seen['accounts.createAccount']).toEqual([[{ app: 'probe', handle: 'ada' }]]);
      expect(seen['accounts.followAccount']).toEqual([
        [{ app: 'probe', follower_account_id: 1, followee_account_id: 2 }]
      ]);
      expect(seen['accounts.getReactionsFor']).toEqual([
        [{ app: 'probe', target_table: 't', target_ids: [1] }]
      ]);
    });

    /**
     * Every pinned row of `MEMBER_APP_ARGS`, not a sample of them. Driven from the table, so
     * a row added later is exercised the moment it exists, and a row whose index or field
     * is wrong fails here by name. The stubs are built from the table too, so a pinned
     * member on a facet this file never stubbed is still reached.
     */
    it('pins every pinned row of MEMBER_APP_ARGS, at the argument and field it names', async () => {
      const rows = Object.entries(
        MEMBER_APP_ARGS as Record<string, AppIdArg | UnpinnedAppIdArg | null>
      ).flatMap(([key, pin]): [string, AppIdArg][] =>
        pin && !('unpinned' in pin) ? [[key, pin]] : []
      );
      expect(rows.length).toBeGreaterThanOrEqual(17);

      const byFacet = new Map<string, string[]>();
      for (const [key] of rows) {
        const [facet, member] = key.split('.');
        byFacet.set(facet, [...(byFacet.get(facet) ?? []), member]);
      }
      const perms = new Set<AppPermission>();
      for (const [facet, members] of byFacet) {
        registerFacet(
          facet as any,
          (() => Object.fromEntries(members.map((m) => [m, record(`${facet}.${m}`)]))) as any
        );
        const needed = permissionOfFacet(facet)?.needed;
        for (const p of needed === null || needed === undefined ? [] : [needed].flat()) {
          perms.add(p);
        }
      }

      const { from } = server([...perms]);
      for (const [key, pin] of rows) {
        const [facet, member] = key.split('.');
        const args: unknown[] = Array.from({ length: pin.arg }, (_, i) => `arg${i}`);
        args.push(pin.field ? { [pin.field]: 'someone-else', kept: key } : 'someone-else');
        from(call(facet, member, args));
      }
      await flush();

      const wrong = rows.flatMap(([key, pin]) => {
        const got = seen[key]?.[0];
        const want = pin.field ? { [pin.field]: 'probe', kept: key } : 'probe';
        const before = Array.from({ length: pin.arg }, (_, i) => `arg${i}`);
        const ok =
          got !== undefined &&
          JSON.stringify(got[pin.arg]) === JSON.stringify(want) &&
          JSON.stringify(got.slice(0, pin.arg)) === JSON.stringify(before);
        return ok ? [] : [`${key}: ${JSON.stringify(got)}`];
      });
      expect(wrong, 'these rows reached the member with the frame’s own id unpinned').toEqual([]);
    });
  });

  /**
   * MICA-345. A row id is not an app id, so the pins above cannot reach it.
   *
   * `notifications.markRead(ids)`/`clear(ids)` and `accounts.updateAccount({ id })` name rows,
   * and the server scopes those only by `citizenid`: every row the player owns is fair game,
   * whichever app it belongs to. Ids are sequential, so an add-on could mark read or clear
   * another app's notifications, or rewrite the player's Blabber profile, by counting. The
   * shell is where the caller's app is known, so the shell narrows the ids to its own.
   */
  describe('row ids in call arguments are narrowed to the calling app’s own rows', () => {
    let seen: Record<string, unknown[][]>;
    const record =
      (key: string) =>
      (...args: unknown[]) => {
        (seen[key] ??= []).push(args);
      };
    const flush = async () => {
      for (let i = 0; i < 6; i++) await Promise.resolve();
    };
    let call = 0;
    const raw = (facet: string, member: string, args: unknown[]) => ({
      kind: 'call',
      id: ++call,
      facet,
      factoryArgs: [],
      member,
      args
    });
    const replyTo = (posted: ToFrame[], id: number) =>
      posted.find((m) => m.kind === 'reply' && m.id === id) as
        Extract<ToFrame, { kind: 'reply' }> | undefined;

    beforeEach(() => {
      seen = {};
      call = 0;
      registerFacet(
        'notifications' as any,
        ((appId?: string) => ({
          // The shade, filtered to the factory's app the way the real facet is.
          notificationsStore: writable(
            [
              { id: 1, app: 'probe' },
              { id: 2, app: 'messages' },
              { id: 3, app: 'probe' }
            ].filter((n) => !appId || n.app === appId)
          ),
          markRead: record('notifications.markRead'),
          clear: record('notifications.clear')
        })) as any
      );
      registerFacet(
        'accounts' as any,
        (() => ({
          getMyAccounts: (app: string) =>
            Promise.resolve({ rows: app === 'probe' ? [{ id: 10 }] : [{ id: 20 }], limit: 3 }),
          updateAccount: record('accounts.updateAccount')
        })) as any
      );
    });

    it('marks read and clears only the frame’s own notifications', async () => {
      const { from } = server(['notifications']);
      from(raw('notifications', 'markRead', [[1, 2, 3]]));
      from(raw('notifications', 'clear', [[2]]));
      from(raw('notifications', 'clear', [[3]]));
      await flush();

      expect(seen['notifications.markRead']).toEqual([[[1, 3]]]);
      // Another app's id alone narrows to nothing; the frame's own still goes through.
      expect(seen['notifications.clear']).toEqual([[[]], [[3]]]);
    });

    it('treats anything but an array of ids as no ids at all', async () => {
      const { from } = server(['notifications']);
      from(raw('notifications', 'markRead', [2]));
      from(raw('notifications', 'clear', [{ length: 1, 0: 2 }]));
      await flush();

      expect(seen['notifications.markRead']).toEqual([[[]]]);
      expect(seen['notifications.clear']).toEqual([[[]]]);
    });

    it('refuses to update an account the frame’s app does not own, and updates its own', async () => {
      const { posted, from } = server(['social']);
      from(raw('accounts', 'updateAccount', [{ id: 20, display_name: 'pwned' }]));
      from(raw('accounts', 'updateAccount', [{ id: 10, display_name: 'mine' }]));
      from(raw('accounts', 'updateAccount', [{ display_name: 'no id' }]));
      await flush();

      expect(seen['accounts.updateAccount']).toEqual([[{ id: 10, display_name: 'mine' }]]);
      expect(replyTo(posted, 1)).toMatchObject({ ok: false });
      expect(replyTo(posted, 2)).toMatchObject({ ok: true });
      expect(replyTo(posted, 3)).toMatchObject({ ok: false });
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
        origin: 'https://cfx-nui-mica'
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

  /**
   * MICA-287: a live add-on frame keeps its own storage cache, filled once at hydrate.
   * Before this, a character switch's settings hydrate never told a frame that was
   * already open, so it went on reading the previous character's values for the rest of
   * the session — the same bug fixed for every in-process app in `host/facets/storage.ts`,
   * for this one wall-crossing case. `pushStorageToAddOns` is the seam `storage.ts` calls
   * on every successful hydrate; these tests stand in for that call directly, since
   * driving the real character-switch flow end to end is `settingsSync.test.ts`'s job.
   */
  describe('MICA-287: a settings hydrate pushes a fresh snapshot to a live frame', () => {
    /** A `Storage`-shaped stub that is its own backing store, so mutating it after hello
     * changes what both `Object.keys` and `getItem` see — a character switch, in place. */
    function stubLocalStorage(): Record<string, string> {
      const stub: Record<string, unknown> = {
        getItem: (key: string) => (stub[key] as string) ?? null
      };
      vi.stubGlobal('localStorage', stub);
      return stub as Record<string, string>;
    }

    it('sends the current snapshot, with a key the new character does not have gone', () => {
      const rawStorage = stubLocalStorage();
      rawStorage[storageKey('probe', 'k')] = '"character A"';

      const { posted, from } = server();
      from({ kind: 'hello', appId: manifest.id });
      posted.length = 0;

      // The switch: the previous character's key is gone, the new one has a different row.
      delete rawStorage[storageKey('probe', 'k')];
      rawStorage[storageKey('probe', 'k2')] = '"character B"';

      pushStorageToAddOns();

      expect(posted).toEqual([
        { kind: 'storage', snapshot: { [storageKey('probe', 'k2')]: '"character B"' } }
      ]);
    });

    it('stops pushing once disposed, rather than holding the frame forever', () => {
      stubLocalStorage();
      const { posted, from, s } = server();
      from({ kind: 'hello', appId: manifest.id });
      s.dispose();
      posted.length = 0;

      pushStorageToAddOns();

      expect(posted).toHaveLength(0);
    });

    it('registers once per guest document, not once per hello — a reload does not double-push', () => {
      const rawStorage = stubLocalStorage();
      const { posted, from, reload } = server();
      from({ kind: 'hello', appId: manifest.id });

      const fresh = reload();
      from({ kind: 'hello', appId: manifest.id }, fresh);
      posted.length = 0;

      rawStorage[storageKey('probe', 'k')] = '"still just one push"';
      pushStorageToAddOns();

      expect(posted.filter((m) => m.kind === 'storage')).toHaveLength(1);
    });
  });
});

/**
 * MICA-245: a widget frame is the same add-on on another surface, so the server that
 * answers it must be the app frame's in everything but the one word that picks the root.
 * Each case below runs the same script against both and compares what comes back.
 */
/**
 * MICA-433: `citizenid` and `device_id` never reach a frame, whatever carries them. The
 * server strips them from owner reads; this is the second fence, so every test here hands
 * the shell a value that still has them, the way a server slip would.
 */
describe('IframeHostServer withholds citizenid and device_id from the frame', () => {
  const leaky = () => ({
    id: 1,
    citizenid: 'ABC12345',
    device_id: 'phone-7',
    owner: { name: 'Ana', citizenid: 'DEF67890', tags: [{ device_id: 'tablet-2', n: 3 }] },
    byId: new Map<unknown, unknown>([
      ['citizenid', 'GHI'],
      ['k', { citizenid: 'JKL', v: 1 }]
    ]),
    seen: new Set<unknown>([{ device_id: 'x', ok: true }])
  });
  const clean = {
    id: 1,
    owner: { name: 'Ana', tags: [{ n: 3 }] },
    byId: new Map<unknown, unknown>([['k', { v: 1 }]]),
    seen: new Set<unknown>([{ ok: true }])
  };

  it('in a reply to a call', async () => {
    registerFacet(
      'contacts' as any,
      (() => ({ contactsStore: store, addContact: () => Promise.resolve([leaky()]) })) as any
    );
    const { posted, from } = server();
    from({
      kind: 'call',
      id: 9,
      facet: 'contacts',
      factoryArgs: [],
      member: 'addContact',
      args: []
    });
    await vi.waitFor(() => expect(posted.some((m) => m.kind === 'reply')).toBe(true));
    expect(posted.find((m) => m.kind === 'reply')).toEqual({
      kind: 'reply',
      id: 9,
      ok: true,
      value: [clean]
    });
  });

  it('in a store push, without touching the shell’s own value', () => {
    const value = [leaky()];
    store = writable<any>(value);
    registerFacet('contacts' as any, (() => ({ contactsStore: store })) as any);
    const { posted, from } = server();
    from({ kind: 'subscribe', id: 4, facet: 'contacts', factoryArgs: [], member: 'contactsStore' });
    expect(posted[posted.length - 1]).toEqual({ kind: 'push', id: 4, value: [clean] });
    expect(value[0].citizenid).toBe('ABC12345');
    expect(value[0].owner.citizenid).toBe('DEF67890');
  });

  it('in the arguments of a callback', async () => {
    registerFacet(
      'contacts' as any,
      (() => ({
        contactsStore: store,
        restoreContact: (cb: (row: unknown) => void) => {
          cb(leaky());
          return () => {};
        }
      })) as any
    );
    const { posted, from } = server();
    from({
      kind: 'call',
      id: 3,
      facet: 'contacts',
      factoryArgs: [],
      member: 'restoreContact',
      args: [{ __cb: 1 }]
    });
    await vi.waitFor(() => expect(posted.some((m) => m.kind === 'callback')).toBe(true));
    expect(posted.find((m) => m.kind === 'callback')).toEqual({
      kind: 'callback',
      cb: 1,
      args: [clean]
    });
  });

  it('in the hydrate payload’s props', () => {
    recordConsent('probe', ['contacts']);
    const posted: ToFrame[] = [];
    const current = { postMessage: (m: ToFrame) => posted.push(structuredClone(m)) };
    const s = createIframeHostServer({
      host: createInProcessHost('probe', ['contacts'] as AppPermission[]),
      manifest,
      props: { row: leaky() },
      guest: () => current,
      onError: vi.fn(),
      onKey: vi.fn(),
      onTyping: vi.fn()
    });
    s.handle({
      data: { kind: 'hello', appId: 'probe' },
      source: current,
      origin: 'null'
    } as unknown as MessageEvent);
    const hydrate = posted.find((m) => m.kind === 'hydrate') as Extract<
      ToFrame,
      { kind: 'hydrate' }
    >;
    expect(hydrate.payload.props).toEqual({ row: clean });
    s.dispose();
  });
});

/**
 * MICA-433: a manifest declaring `admin` is shut down at its first message, before any
 * facet is built. `defineApp` refuses one already; this is the fence for a manifest that
 * reached the shell some other way.
 */
describe('IframeHostServer refuses a frame whose manifest declares admin', () => {
  const frameWith = (permissions: AppPermission[]) => {
    recordConsent('probe', permissions);
    const onEscape = vi.fn();
    const posted: ToFrame[] = [];
    const current = { postMessage: (msg: ToFrame) => posted.push(msg) };
    const s = createIframeHostServer({
      host: createInProcessHost('probe', permissions),
      manifest: {
        id: 'probe',
        name: 'Probe',
        icon: 'x',
        core: false,
        permissions
      } as unknown as ReturnType<typeof defineApp>,
      props: {},
      guest: () => current,
      onError: vi.fn(),
      onEscape,
      onKey: vi.fn(),
      onTyping: vi.fn()
    });
    const from = (data: unknown) =>
      s.handle({ data, source: current, origin: 'null' } as unknown as MessageEvent);
    return { posted, from, onEscape, s };
  };

  it('answers neither hello nor a call to the moderation queue', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const isAdmin = vi.fn(() => true);
    registerFacet('admin' as any, (() => ({ isAdmin, refreshAdmin: isAdmin })) as any);
    const { posted, from, onEscape } = frameWith(['admin', 'contacts'] as AppPermission[]);

    from({
      kind: 'call',
      id: 1,
      facet: 'admin',
      factoryArgs: [],
      member: 'refreshAdmin',
      args: []
    });
    from({ kind: 'hello', appId: 'probe' });
    await Promise.resolve();
    await Promise.resolve();

    expect(posted).toEqual([]);
    expect(isAdmin).not.toHaveBeenCalled();
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("declares 'admin'"));
    error.mockRestore();
  });

  it('still answers the same frame without it', () => {
    const { posted, from, onEscape } = frameWith(['contacts'] as AppPermission[]);
    from({ kind: 'hello', appId: 'probe' });
    expect(posted.map((m) => m.kind)).toContain('hydrate');
    expect(onEscape).not.toHaveBeenCalled();
  });
});

describe('IframeHostServer in widget mode', () => {
  function pair(permissions: AppPermission[], granted: AppPermission[]) {
    recordConsent('probe', granted);
    const build = (mode: 'app' | 'widget' | undefined) => {
      const posted: ToFrame[] = [];
      const guest = { postMessage: (m: ToFrame) => posted.push(m) };
      const s = createIframeHostServer({
        host: createInProcessHost('probe', permissions),
        manifest,
        props: mode === 'widget' ? { size: '2x1' } : {},
        mode,
        guest: () => guest,
        onError: vi.fn(),
        onKey: vi.fn(),
        onTyping: vi.fn()
      });
      const from = (data: unknown) =>
        s.handle({ data, source: guest, origin: 'null' } as unknown as MessageEvent);
      return { posted, from };
    };
    return { app: build(undefined), widget: build('widget') };
  }

  const payloadOf = (posted: ToFrame[]) =>
    (posted.find((m) => m.kind === 'hydrate') as Extract<ToFrame, { kind: 'hydrate' }>).payload;

  it('hydrates with the mode and size, and otherwise exactly the app frame’s payload', () => {
    const { app, widget } = pair(['contacts', 'storage'], ['storage']);
    app.from({ kind: 'hello', appId: 'probe' });
    widget.from({ kind: 'hello', appId: 'probe' });

    const a = payloadOf(app.posted);
    const w = payloadOf(widget.posted);
    expect('mode' in a).toBe(false);
    expect(w.mode).toBe('widget');
    expect(w.props).toEqual({ size: '2x1' });
    expect(w.permissions).toEqual(['storage']);
    const { mode: _m, props: _wp, ...wRest } = w;
    const { props: _ap, ...aRest } = a;
    expect(wRest).toEqual(aRest);
  });

  it('refuses an undeclared and an ungranted permission exactly as the app frame does', async () => {
    const undeclared = pair([], []);
    const ungranted = pair(['contacts'], []);
    const call = {
      kind: 'call',
      id: 1,
      facet: 'contacts',
      factoryArgs: [],
      member: 'addContact',
      args: ['ab']
    };
    for (const { app, widget } of [undeclared, ungranted]) {
      app.from(call);
      widget.from(call);
      await vi.waitFor(() => expect(widget.posted).toHaveLength(1));
      await vi.waitFor(() => expect(app.posted).toHaveLength(1));
      expect(widget.posted[0]).toMatchObject({
        kind: 'reply',
        ok: false,
        error: { name: 'AppPermissionError', permission: 'contacts' }
      });
      expect(widget.posted).toEqual(app.posted);
    }
  });

  it('answers a granted call exactly as the app frame does', async () => {
    const { app, widget } = pair(['contacts'], ['contacts']);
    const call = {
      kind: 'call',
      id: 1,
      facet: 'contacts',
      factoryArgs: [],
      member: 'addContact',
      args: ['ab']
    };
    app.from(call);
    widget.from(call);
    await vi.waitFor(() => expect(widget.posted).toHaveLength(1));
    await vi.waitFor(() => expect(app.posted).toHaveLength(1));
    expect(widget.posted[0]).toMatchObject({ kind: 'reply', ok: true, value: { id: 2 } });
    expect(widget.posted).toEqual(app.posted);
  });
});
