// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { get } from 'svelte/store';
import type { Host } from '../../../../sdk/host/protocol';
import { AppPermissionError } from '../../../../sdk/host/protocol';
import { facets } from '../../../../sdk/host/current';
import { permissionOfFacet, DENIED_FACETS, membersOfFacet } from '../../../../sdk/permissions';
import type { AppManifest, AppPermission } from '../../../../sdk/manifest';
import { SDK_CONTRACT_VERSION } from '../../../../sdk/version';
import type {
  ToFrame,
  ToShell,
  HydratePayload,
  AddOnConstants
} from '../../../../sdk/host/iframe/messages';
import { isCallbackRef } from '../../../../sdk/host/iframe/messages';
import { grantFor } from '../state/registry';
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
   * This frame must not go on running, and `message` is what to tell the player
   * (MICA-196).
   *
   * Separate from `onError`, which reports a crash *inside* a guest that is still the
   * guest and still the add-on. This fires when the thing in the frame is not the add-on
   * any more — it navigated itself to a remote origin — or when it never could have been
   * the add-on this phone can run, because its bundle was built against a different SDK
   * contract. Either way the caller's job is to take the frame off screen rather than to
   * render a stack trace.
   *
   * `message` is player-facing prose, not the diagnostic: the technical detail goes to the
   * console, where a developer will look, and this goes on a crash screen, where a player
   * will. Optional so a test that only cares about the message path need not supply it.
   */
  onEscape?(message: string): void;
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

/**
 * What one frame may hold and how fast it may ask (MICA-196).
 *
 * Nothing bounded any of this. `subscriptions` grew one entry per `subscribe` and each
 * entry is a **live store listener in the shell**, so a loop in a frame — malicious, or a
 * `$effect` that resubscribes on every push — could hold thousands of them and keep every
 * store they touch fanning out to a dead sandbox for the life of the page. `instances` was
 * keyed on `facet:JSON(factoryArgs)`, and while `pinAppId` stops the *app id* in there from
 * being a lie, the rest of the key is still whatever the frame sent, so it is a map an
 * add-on can grow by asking. And `call` had no rate at all, on a channel where each message
 * can reach a real facet and, through `service`, the server.
 *
 * Exported so the tests name these rather than hardcoding a number that would silently stop
 * meaning the limit if it were tuned.
 *
 * The numbers are chosen against real bursts, the way `server/lib/rateLimit.ts` chooses
 * its own. A frame's heaviest honest moment is the one just after `hydrate`, when its
 * stores subscribe and its first screen loads: tens of messages, not hundreds. Sixty a
 * second sustained is nothing an add-on can honestly need and still leaves a slow machine's
 * opening burst untouched.
 */
export const ADDON_LIMITS = {
  /**
   * Fixed window, matching `rateLimit.ts`'s shape rather than importing it — that module is
   * FiveM server code (it reads `GetConvar` and hooks `playerDropped`) and nothing in `web/`
   * can load it. A window needs a counter and a start time; a token bucket needs a per-key
   * refill timestamp and float arithmetic, and the two only differ at a burst boundary where
   * the honest answer is "ask again in a moment" either way.
   */
  windowMs: 10_000,
  /**
   * Counted over `call` **and** `subscribe` together. A subscribe/unsubscribe loop is a call
   * flood spelled differently, and a limit that only saw `call` would watch it go past.
   */
  requestsPerWindow: 600,
  /** Live store listeners held in the shell on this frame's behalf. */
  subscriptions: 200,
  /**
   * Distinct `facet(factoryArgs)` objects cached for this frame. Every facet twin but
   * `service` passes `[]` or the pinned app id, so an honest frame sits far below this —
   * the headroom is for `service`, whose id varies within the app's own namespace.
   */
  instances: 128
} as const;

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
  /** The fixed request window: when it opened, and how many have arrived in it. */
  let windowStartedAt = 0;
  let requestsInWindow = 0;

  /**
   * Record one inbound `call`/`subscribe` and say whether to answer it.
   *
   * Refuses rather than tearing the frame down. A frame over its budget is far more likely
   * to be a resubscribe loop in somebody's add-on than an attack, and killing the app over
   * a bug it can recover from would trade a bounded cost for an unbounded one. `call`
   * answers the refusal as an ordinary failed reply, so the add-on's own `await` rejects
   * and it can say so; `subscribe` logs, which is what it already does for every refusal.
   *
   * The window is not reset by `forgetGuest`: a reload is exactly what a frame trying to
   * shed its budget would do, and the budget belongs to the frame rather than to the
   * document in it.
   */
  function withinBudget(): boolean {
    const at = Date.now();
    if (at - windowStartedAt >= ADDON_LIMITS.windowMs) {
      windowStartedAt = at;
      requestsInWindow = 1;
      return true;
    }
    requestsInWindow += 1;
    return requestsInWindow <= ADDON_LIMITS.requestsPerWindow;
  }

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

  /**
   * The player's own answer, checked after the manifest's declaration (MICA-201).
   *
   * `host.require` asks what the installed manifest **declares**. That was the whole test
   * until now, which made the installed manifest its own authorization: anything able to
   * write one — a modified Store, or core code taking a catalog entry at its word — widened
   * what an add-on may reach with nobody asked. The grant is the shell's separate record of
   * what a player actually accepted (`shell/state/addOnGrants.ts`), written only through
   * `appRegistryWrite.recordConsent`, which no add-on can name.
   *
   * So a declared permission with no matching grant is refused here in exactly the way an
   * undeclared one is refused above — the same `AppPermissionError`, so the frame's own
   * error handling, the reply encoding and the add-on's `catch` all see one failure mode
   * rather than two. An update that adds a permission therefore does nothing at all until
   * the player answers the Store's prompt and the grant widens.
   */
  function requireGranted(
    needed: AppPermission | readonly AppPermission[] | null,
    hookName: string
  ): void {
    if (needed === null) return;
    const granted = grantFor(host.appId);
    // `typeof`, not `Array.isArray`: on a `readonly` array type the latter narrows the other
    // branch to `any[]`, and every element check below would go unchecked.
    const required: readonly AppPermission[] = typeof needed === 'string' ? [needed] : needed;
    for (const permission of required) {
      if (!granted.includes(permission)) {
        throw new AppPermissionError(host.appId, permission, hookName);
      }
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
    requireGranted(perm.needed, perm.hook);
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
      // MICA-196: the key is partly frame-supplied, so this map is one an add-on can
      // grow by asking. Refusing a *new* one rather than evicting: every cached facet may
      // be holding live state on the frame's behalf, and dropping one at random would make
      // an add-on's own object silently stop working instead of failing where it asked.
      if (instances.size >= ADDON_LIMITS.instances) {
        throw new Error(
          `[gPhone] '${host.appId}' has too many live facet instances (${ADDON_LIMITS.instances})`
        );
      }
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
      if (!withinBudget()) {
        throw new Error(
          `[gPhone] '${host.appId}' is calling the shell too fast ` +
            `(over ${ADDON_LIMITS.requestsPerWindow} in ${ADDON_LIMITS.windowMs}ms)`
        );
      }
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
      if (!withinBudget()) {
        throw new Error(
          `[gPhone] '${host.appId}' is calling the shell too fast ` +
            `(over ${ADDON_LIMITS.requestsPerWindow} in ${ADDON_LIMITS.windowMs}ms)`
        );
      }
      // Each entry is a live store listener in the shell, and a store goes on fanning out
      // to one whether or not the frame is still reading. Counted before the facet is
      // built, so an over-budget subscribe costs nothing at all. An id already in the map
      // is a replacement rather than a new listener — see the `hello` path, which drops the
      // previous document's whole set — so it is not counted against the cap twice.
      if (!subscriptions.has(msg.id) && subscriptions.size >= ADDON_LIMITS.subscriptions) {
        throw new Error(
          `[gPhone] '${host.appId}' holds too many live subscriptions ` +
            `(${ADDON_LIMITS.subscriptions})`
        );
      }
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
    /**
     * MICA-196: the last place a mismatched bundle can be stopped before it runs.
     *
     * `registerAddOn` refuses one at install, which is where a player sees a useful
     * message, and this is the same check where the *code* is about to start: a bundled
     * add-on registered by a path that never went through an install, a dev registration,
     * or an install from a build before the gate existed. Refusing here costs one string
     * comparison per `hello` and closes the gap between "was allowed in" and "is running".
     *
     * Before `post`, deliberately. The hydrate payload carries the player's theme, this
     * app's stored keys and the display constants; a bundle this phone has already decided
     * it cannot run should not receive any of it on the way out.
     */
    const built = manifest.sdkContract;
    if (built !== undefined && built !== SDK_CONTRACT_VERSION) {
      escaped(
        `its bundle was built against SDK contract '${built}' and this phone provides ` +
          `'${SDK_CONTRACT_VERSION}'`,
        `${manifest.name} was built for a different version of gPhone (SDK contract ` +
          `${built}; this phone provides ${SDK_CONTRACT_VERSION}).`
      );
      return;
    }

    // `grantFor`, not the raw record: an add-on shipped in this repository is vouched for
    // by the build, so its declared permissions stand where no grant was ever recorded — a
    // deep link or a dev registration reaches a bundled add-on with no install sheet and no
    // player to ask. A remote add-on keeps the strict rule (MICA-201).
    const granted = grantFor(host.appId);
    const payload: HydratePayload = {
      appId: host.appId,
      // `host.permissions` is a Svelte reactive array (a `$state` proxy) on an
      // in-process host; a Proxy cannot survive `postMessage`'s structured clone, so a
      // plain copy crosses the wall instead.
      // Declared **and** granted (MICA-201). The frame's own `require` is a courtesy
      // check inside the sandbox, and handing it the manifest's full list would have it
      // cheerfully make calls the shell then refuses; the intersection is what the phone
      // will actually answer, so the two checks agree. `host.permissions` is a Svelte
      // reactive array (a `$state` proxy) on an in-process host, and a Proxy cannot survive
      // `postMessage`'s structured clone, so this crosses the wall as a plain array either
      // way.
      permissions: host.permissions.filter((p) => granted.includes(p)),
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
  function escaped(detail: string, message: string): void {
    if (disposed) return;
    console.error(`[gPhone] add-on '${manifest.id}': ${detail}. The frame has been shut down.`);
    shutDown();
    opts.onEscape?.(message);
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
              `be opaque, so the add-on navigated itself away`,
            'This add-on tried to navigate away from its own code and has been stopped.'
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
