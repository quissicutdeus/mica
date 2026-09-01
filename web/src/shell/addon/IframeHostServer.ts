// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { get } from 'svelte/store';
import type { Host } from '../../../../sdk/host/protocol';
import { AppPermissionError } from '../../../../sdk/host/protocol';
import { facets } from '../../../../sdk/host/current';
import { permissionOfFacet, DENIED_FACETS, membersOfFacet } from '../../../../sdk/permissions';
import type { AppManifest } from '../../../../sdk/manifest';
import type {
  ToFrame,
  ToShell,
  HydratePayload,
  AddOnConstants
} from '../../../../sdk/host/iframe/messages';
import { isCallbackRef } from '../../../../sdk/host/iframe/messages';
import { themeStyleStore } from '../state/theme';
import { is24Hour } from '../state/time';
import { messageOf } from '@gphone/sdk';

/** The guest end of the channel: the window a frame is currently running. */
export interface GuestWindow {
  postMessage(msg: ToFrame, origin: string): void;
}

export interface IframeHostServerOptions {
  host: Host;
  manifest: AppManifest;
  props: Record<string, unknown>;
  /**
   * The frame's window, resolved on every message rather than captured once (MICA-90).
   *
   * It is both ends of the channel: what outbound messages are posted to, and what
   * `event.source` must equal for an inbound one to be accepted. One accessor rather than
   * two options because the two can only ever disagree by accident, and that disagreement
   * was the bug — a `hello` refused as a stranger while replies went to a dead window.
   *
   * Resolving late is what makes a reloaded frame recoverable at all. A frame that comes
   * back as a new window sends its one `hello` from that window during its own script
   * execution, which is *before* its `load` event — so any binding refreshed on `load` is
   * refreshed one step too late to accept the message it exists to accept. Asking the
   * element who it is running right now turns the check into "is this the window in my
   * frame?", which a reloaded guest satisfies on its first try with nothing to rebuild.
   */
  guest: () => GuestWindow | null | undefined;
  onError(message: string, stack: string | null): void;
  /**
   * The frame stopped being the document this server was built for, and nothing it says
   * can be trusted again (MICA-196).
   *
   * Separate from `onError`, which reports a crash *inside* a guest that is still the
   * guest. This one fires when the guest is a different document than the one hydrated —
   * a self-navigation to a remote origin, or a second `load` — and the caller's job is to
   * take the frame off screen rather than to render a stack trace. Optional so a test that
   * only cares about the message path does not have to supply it.
   */
  onEscape?(reason: string): void;
  onKey(key: Extract<ToShell, { kind: 'key' }>): void;
  onTyping(typing: boolean): void;
}

const isStore = (v: unknown): v is { subscribe: (cb: (x: unknown) => void) => () => void } =>
  !!v && typeof v === 'object' && typeof (v as { subscribe?: unknown }).subscribe === 'function';

/**
 * Every `gphone:<appId>:` key, raw — the frame's sync storage reads come from this.
 *
 * Keys stay **full** (`gphone:<appId>:<key>`), not stripped of their prefix: the iframe
 * twin's `storage.ts` reads its cache with `getStorageKey`, which re-adds the same prefix
 * before every `readKey`/`writeKey` call — so a stripped snapshot key never matched what
 * the twin looked up, and every `useStorage`/`usePersisted` read inside an add-on silently
 * fell through to its default value.
 */
function storageSnapshot(appId: string): Record<string, string> {
  const prefix = `gphone:${appId}:`;
  const out: Record<string, string> = {};
  if (typeof localStorage === 'undefined') return out;
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith(prefix)) out[key] = localStorage.getItem(key) ?? '';
  }
  return out;
}

/** Plain values the frame needs synchronously; read once from the live facets. */
function constantsFor(): AddOnConstants {
  const d = facets.display() as Record<string, unknown>;
  const numbers = Object.fromEntries(
    Object.entries(d).filter(([, v]) => typeof v === 'number')
  ) as Record<string, number>;
  const w = facets.wallpaper() as { presets: unknown; defaultWallpaper: unknown };
  const h = facets.systemHardware() as { volumeStepChoices: unknown };
  const t = facets.theme() as { defaultTheme: unknown };
  return {
    display: numbers,
    wallpaper: { presets: w.presets, defaultWallpaper: w.defaultWallpaper },
    systemHardware: { volumeStepChoices: h.volumeStepChoices },
    theme: { defaultTheme: t.defaultTheme },
    // Read straight off the shell's own store rather than through the `clock` facet: the
    // frame's `is24Hour` shim needs a *synchronous* answer (`formatTime`'s default reads
    // it during the first paint, before any subscribe reply could land), and this is the
    // one place that can give it one. A mid-session toggle of the 24-hour setting does
    // not reach an already-booted frame — see `iframe/shims/time.ts` for why that is
    // deliberate rather than an oversight.
    clock: { is24Hour: get(is24Hour) }
  };
}

export function createIframeHostServer(opts: IframeHostServerOptions) {
  const { host, manifest, guest } = opts;
  const post = (msg: ToFrame) => guest()?.postMessage(msg, '*');
  const instances = new Map<string, Record<string, unknown>>();
  const subscriptions = new Map<number, () => void>();
  const handles = new Map<number, (...a: unknown[]) => unknown>();
  let nextHandle = 1;
  let disposed = false;
  let stopTheme: (() => void) | undefined;
  /** The window whose `hello` was last answered — how a reload is recognised. */
  let hydrated: unknown;

  /**
   * Whose server service this add-on may name.
   *
   * The declaration when there is one (MICA-196): `manifest.services` is checked at
   * definition time to sit inside the app's own namespace, and the registry refuses an
   * install whose claim collides with an installed app's, so an exact-match test here is
   * both narrower than the prefix rule and backed by something.
   *
   * The prefix rule survives as the answer for a manifest that declares nothing, which is
   * every add-on published before the field existed. It is kept **only** for that: it
   * cannot tell an app that owns `blabber_dms` from one whose id merely prefixes it, over a
   * flat namespace that already holds exactly that pair. Reading an absent `services` as an
   * empty list instead would be the correct rule and would also break every published
   * add-on at once, which is not a trade this surface gets to make. Declaring `services` is
   * how an app opts out of the ambiguous answer.
   */
  const serviceAllowed = (id: unknown) => {
    if (typeof id !== 'string') return false;
    const declared = manifest.services;
    if (declared) return declared.includes(id);
    return id === host.appId || id.startsWith(`${host.appId}_`);
  };

  /**
   * Facets whose **first factory argument is an app id** — the app the resulting object
   * reads and writes on behalf of.
   *
   * A permission check answers "may this add-on use storage at all"; it says nothing
   * about *whose* storage. Nothing in the bundle a player installs has to be involved:
   * the frame's own script can `window.parent.postMessage({ kind: 'call', facet:
   * 'storage', factoryArgs: ['settings'], member: 'setItem', args: [...] })` and, before
   * this table, the server would have handed it a `storage('settings')` — the shell's own
   * preferences namespace — because the declared `storage` permission passed. The same
   * raw message against `appEvents`/`appAction`/`notifications` lets one add-on listen to
   * another app's events, run actions under its name, or read and clear its notification
   * list.
   *
   * So the id is not trusted, it is *stated*: whatever arrived in `factoryArgs[0]` is
   * replaced with `host.appId`. `notifications()` with no argument means "every app" on
   * the in-process side, and becomes `notifications(host.appId)` here for the same reason.
   *
   * `lifecycle` (MICA-27) is here for the same reason: its `onBack` takes only a
   * handler as a call argument now, with no owner argument left to smuggle a lie through —
   * ownership comes entirely from this pin.
   */
  const APP_SCOPED_FACETS: ReadonlySet<string> = new Set([
    'storage',
    'appStorageBytes',
    'clearAppStorage',
    'appEvents',
    'notifications',
    'appAction',
    'persisted',
    'deepLink',
    'lifecycle'
  ]);

  /**
   * The same pin for the one facet that carries the app id inside a config object.
   *
   * `appLevels`' twin never round-trips (it runs in the frame and reaches the shell
   * through `lifecycle.onBack`, which is pinned already — see `APP_SCOPED_FACETS`), so
   * this is defensive: a raw `call` naming the facet directly is still a message the
   * server has to answer safely.
   */
  const CONFIG_APP_ID_FACETS: ReadonlySet<string> = new Set(['appLevels']);

  // `DENIED_FACETS` and `membersOfFacet` are imported from `sdk/permissions.ts`, not
  // declared here (MICA-33, MICA-196): see that file's doc comments for which facets
  // and why. `DENIED_FACETS` used to be a local set with a second, independently hand-typed
  // copy in `IframeHostServer.test.ts` — two places the same five names had to agree, with
  // nothing checking that they did, or that a sixth bare-function facet ever gets added to
  // either. `permissions.test.ts` now proves every *implicit* facet is classified as this
  // shape or the safe one; a facet that instead requires a real permission
  // (`clearAppStorage`/`appStorageBytes`) is denied here for the same shape reason but
  // needs no such proof, since its permission already gates it.
  //
  // The per-member table moved for the same reason and one more: it used to be default-
  // *allow*, so a facet nobody had thought about exposed everything, and four separate
  // tickets each closed one instance of that. `FACET_MEMBERS` is default-deny and total,
  // which is what makes the next one a test failure rather than a discovery.

  /** Throws unless `member` is reachable on `facet` from inside the sandbox. */
  function requireMember(facet: string, member: string): void {
    if (DENIED_FACETS.has(facet)) {
      throw new Error(`[gPhone] '${facet}' is not reachable directly`);
    }
    const allowed = membersOfFacet(facet);
    if (!allowed) {
      throw new Error(`[gPhone] '${facet}' is not reachable from an add-on`);
    }
    if (!allowed.includes(member)) {
      throw new Error(`[gPhone] '${facet}.${member}' is core only`);
    }
  }

  /** `factoryArgs` with any app id in it replaced by the calling app's own. */
  function pinAppId(facet: string, factoryArgs: readonly unknown[]): readonly unknown[] {
    if (APP_SCOPED_FACETS.has(facet)) return [host.appId, ...factoryArgs.slice(1)];
    if (CONFIG_APP_ID_FACETS.has(facet)) {
      const config = factoryArgs[0];
      const pinned =
        config && typeof config === 'object'
          ? { ...config, appId: host.appId }
          : { appId: host.appId };
      return [pinned, ...factoryArgs.slice(1)];
    }
    return factoryArgs;
  }

  /**
   * Resolve (and cache) the facet object for `facet(factoryArgs)`, after the permission
   * check — `host.require` is a no-op for an implicit (`null`) permission, `lifecycle`
   * included, so there is no separate "skip the check" path to maintain (MICA-27).
   */
  function instance(facet: string, factoryArgs: readonly unknown[]): Record<string, unknown> {
    const perm = permissionOfFacet(facet);
    if (!perm) throw new Error(`[gPhone] unknown facet '${facet}'`);
    host.require(perm.needed, perm.hook);
    if (facet === 'service' && !serviceAllowed(factoryArgs[0])) {
      throw new Error(
        `[gPhone] '${host.appId}' may only use its own service, not '${String(factoryArgs[0])}'`
      );
    }
    // After the checks, before the cache key: an id the frame sent must never reach the
    // factory *or* be able to name a second cache entry.
    const pinnedArgs = pinAppId(facet, factoryArgs);
    const key = `${facet}:${JSON.stringify(pinnedArgs)}`;
    let obj = instances.get(key);
    if (!obj) {
      const factory = (facets as unknown as Record<string, (...a: unknown[]) => unknown>)[facet];
      obj = factory(...pinnedArgs) as Record<string, unknown>;
      instances.set(key, obj);
    }
    return obj;
  }

  const decodeArgs = (args: unknown[]): unknown[] =>
    args.map((a) => {
      if (isCallbackRef(a))
        return (...cbArgs: unknown[]) => post({ kind: 'callback', cb: a.__cb, args: cbArgs });
      if (a && typeof a === 'object' && !Array.isArray(a)) {
        return Object.fromEntries(
          Object.entries(a).map(([k, v]) => [
            k,
            isCallbackRef(v)
              ? (...cbArgs: unknown[]) => post({ kind: 'callback', cb: v.__cb, args: cbArgs })
              : v
          ])
        );
      }
      return a;
    });

  const encodeResult = (v: unknown): unknown => {
    if (typeof v === 'function') {
      const h = nextHandle++;
      handles.set(h, v as (...a: unknown[]) => unknown);
      return { __fn: h };
    }
    if (
      v &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      Object.getPrototypeOf(v) === Object.prototype
    ) {
      return Object.fromEntries(
        Object.entries(v).map(([k, x]) => [k, typeof x === 'function' ? encodeResult(x) : x])
      );
    }
    return v;
  };

  const fail = (id: number, e: unknown) =>
    post({
      kind: 'reply',
      id,
      ok: false,
      error:
        e instanceof AppPermissionError
          ? { name: e.name, message: e.message, permission: e.permission, hookName: e.hookName }
          : { name: e instanceof Error ? e.name : 'Error', message: messageOf(e, 'unknown error') }
    });

  async function call(msg: Extract<ToShell, { kind: 'call' }>) {
    try {
      requireMember(msg.facet, msg.member);
      const obj = instance(msg.facet, msg.factoryArgs);
      const member = obj[msg.member];
      if (typeof member !== 'function')
        throw new Error(`[gPhone] '${msg.facet}.${msg.member}' is not callable`);
      const args = decodeArgs(msg.args);
      const value: unknown = await member.apply(obj, args);
      if (!disposed) post({ kind: 'reply', id: msg.id, ok: true, value: encodeResult(value) });
    } catch (e) {
      // A synchronous throw here (unknown facet, missing permission, non-function
      // member) would otherwise settle in the very same tick it was handled in, ahead
      // of an earlier `call` still awaiting its member — so it yields once too, to the
      // same depth an awaited member reply settles at, keeping same-tick calls replying
      // in the order they arrived rather than the order they finished.
      await Promise.resolve();
      if (!disposed) fail(msg.id, e);
    }
  }

  function subscribe(msg: Extract<ToShell, { kind: 'subscribe' }>) {
    try {
      requireMember(msg.facet, msg.member);
      const obj = instance(msg.facet, msg.factoryArgs);
      const member = obj[msg.member];
      if (!isStore(member)) throw new Error(`[gPhone] '${msg.facet}.${msg.member}' is not a store`);
      subscriptions.set(
        msg.id,
        member.subscribe((value) => {
          if (!disposed) post({ kind: 'push', id: msg.id, value });
        })
      );
    } catch (e) {
      console.error(`[gPhone] add-on '${host.appId}' subscribe failed:`, e);
    }
  }

  /** Stop answering, permanently. The public `dispose()` and `escaped()` both land here. */
  function shutDown() {
    disposed = true;
    forgetGuest();
  }

  /** Drop everything held on behalf of one guest document. */
  function forgetGuest() {
    stopTheme?.();
    stopTheme = undefined;
    for (const off of subscriptions.values()) off();
    subscriptions.clear();
    handles.clear();
    instances.clear();
  }

  function hydrate() {
    const payload: HydratePayload = {
      appId: host.appId,
      // `host.permissions` is a Svelte reactive array (a `$state` proxy) on an
      // in-process host; a Proxy cannot survive `postMessage`'s structured clone, so a
      // plain copy crosses the wall instead.
      permissions: [...host.permissions],
      props: opts.props,
      theme: get(themeStyleStore),
      storage: storageSnapshot(host.appId),
      constants: constantsFor()
    };
    post({ kind: 'hydrate', payload });
    // Started only once a hello is answered: an app that never announces itself never
    // gets a live theme feed, and the first (synchronous) value is already in the
    // hydrate payload above, so a later push is only ever a real change.
    if (!stopTheme) stopTheme = themeStyleStore.subscribe((css) => post({ kind: 'theme', css }));
  }

  /**
   * The guest is no longer the document this server hydrated. Stop answering it, for good.
   *
   * `dispose()` rather than `forgetGuest()`: forgetting drops what was held on behalf of a
   * guest and leaves the channel open for the next `hello`, which is right for a reload and
   * exactly wrong here — the whole problem is that the thing on the other end is not the
   * add-on any more. The server stays dead until `AddOnFrame` builds a new one against a
   * new element, which is what Restart does.
   */
  function escaped(reason: string): void {
    if (disposed) return;
    console.error(`[gPhone] add-on '${manifest.id}': ${reason}. The frame has been shut down.`);
    shutDown();
    opts.onEscape?.(reason);
  }

  return {
    handle(this: void, event: MessageEvent) {
      if (disposed) return;
      /**
       * MICA-196: the guest posts from an opaque origin, and says so as the literal
       * string `'null'`.
       *
       * `sandbox="allow-scripts"` with no `allow-same-origin` gives the srcdoc document an
       * opaque origin, and an opaque origin serialises to `"null"` in `event.origin`. A
       * document that navigated itself somewhere real does not: it posts its real origin.
       *
       * That distinction is the only one available here, because `event.source` cannot make
       * it. A `WindowProxy` survives navigation — same object, new document — so a guest
       * that sets `location.href = 'https://evil'` still satisfies `event.source ===
       * guest()`, and every check below it would go on answering a remote page as though it
       * were the add-on. The origin is what changes underneath.
       *
       * Anything else on the page also lands here: `window.addEventListener('message', ...)`
       * is not scoped to the frame, so the dev harness's own `postMessage` (`appEvent`,
       * `setVisible`) arrives with the shell's real origin. Those are ordinary and silent —
       * they fail the `source` check too. It is only a message that is *both* from a real
       * origin *and* from the window in this frame that means the frame left.
       */
      if (event.origin !== 'null') {
        if (event.source === guest()) {
          escaped(
            `a message arrived from origin '${event.origin}' in a frame whose document must ` +
              `be opaque, so the add-on navigated itself away`
          );
        }
        return;
      }
      if (event.source !== guest()) {
        /**
         * Loud, because this is the shape of failure with no symptom.
         *
         * A refused `hello` means an add-on that sits blank — still mounted, still
         * running, with nothing in any console to look for. That cost a long evening once.
         *
         * It no longer means "the frame reloaded": `guest()` is read here, at delivery, so
         * whatever window is in the frame right now is by definition the one accepted
         * (MICA-90). Reaching this line means a `hello` arrived from a window that is
         * not in this frame at all — a sibling add-on's frame, or one already torn out of
         * the DOM — which is a wiring bug rather than a race, and worth the same noise.
         *
         * Only `hello` is worth reporting: it is the one message whose loss is fatal, and
         * a stray `call`/`subscribe` from a dying frame is ordinary teardown noise.
         */
        const stray = event.data as { kind?: unknown; appId?: unknown } | null;
        if (stray && typeof stray === 'object' && stray.kind === 'hello') {
          console.error(
            `[gPhone] add-on '${manifest.id}' said hello from a window that is not the one ` +
              `in its frame, and will stay blank. The frame it came from is not the one ` +
              `this host was given.`
          );
        }
        return;
      }
      const msg = event.data as ToShell;
      if (!msg || typeof msg !== 'object' || typeof msg.kind !== 'string') return;
      switch (msg.kind) {
        case 'hello':
          if (msg.appId !== manifest.id) {
            console.error(
              `[gPhone] add-on frame for '${manifest.id}' announced '${msg.appId}'; refused.`
            );
            return;
          }
          /**
           * A second `hello` is a reloaded frame: the guest sends exactly one, from its
           * own script execution, so a new one means a new document is running in there.
           *
           * Everything below belongs to the guest that is gone. Its subscription ids start
           * from 1 again in the new document, so keeping them would leak a live store
           * subscription per id the moment the new guest reused it, and every handle it
           * was ever given is now unreachable. Dropping the whole set is what the teardown
           * on rebuild used to do; the server outlives a reload now, so it does it here.
           */
          if (hydrated !== undefined && hydrated !== event.source) forgetGuest();
          hydrated = event.source;
          hydrate();
          break;
        case 'call':
          void call(msg);
          break;
        case 'subscribe':
          subscribe(msg);
          break;
        case 'unsubscribe':
          subscriptions.get(msg.id)?.();
          subscriptions.delete(msg.id);
          break;
        case 'invoke':
          // MICA-23: every handle `encodeResult` hands out is documented (messages.ts)
          // as a one-shot unsubscribe/release — nothing in this codebase invokes one
          // twice — so this is the one place that call/subscription "ends", and the
          // entry can go rather than living until the whole frame tears down.
          handles.get(msg.handle)?.(...msg.args);
          handles.delete(msg.handle);
          break;
        case 'error':
          opts.onError(msg.message, msg.stack);
          break;
        case 'key':
          opts.onKey(msg);
          break;
        case 'typing':
          opts.onTyping(msg.typing);
          break;
      }
    },
    dispose() {
      shutDown();
    },
    /**
     * MICA-25: a new deep link into an add-on that is already open. `AddOnFrame.svelte`
     * calls this instead of rebuilding the server — the frame already ran its one `hello`
     * and has no way to receive a second, so there is nothing here to hydrate again, only
     * a props update to push to the sandbox's own reactive props object.
     */
    pushProps(props: Record<string, unknown>) {
      if (!disposed) post({ kind: 'props', props });
    }
  };
}
