// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { get, type Readable } from 'svelte/store';
import type { Host } from '../../../../sdk/host/protocol';
import { AppPermissionError } from '../../../../sdk/host/protocol';
import { facets } from '../../../../sdk/host/current';
import {
  appIdArgOf,
  permissionOfFacet,
  DENIED_FACETS,
  membersOfFacet
} from '../../../../sdk/permissions';
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
import { isRefusal, messageOf } from '@mica/sdk';
import { registerAddOnStoragePush } from '../../host/settingsSync';

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
  /**
   * MICA-245: which root the frame mounts. Absent is the app. It changes the one word in
   * the hydrate payload and nothing else — the host, the grant, the facet table and every
   * limit below are the app frame's, because a widget is the same add-on on another surface.
   */
  mode?: 'app' | 'widget';
  /** MICA-245: the frame says its widget root mounted. Only a widget frame sends it. */
  onReady?(): void;
}

const isStore = (v: unknown): v is { subscribe: (cb: (x: unknown) => void) => () => void } =>
  !!v && typeof v === 'object' && typeof (v as { subscribe?: unknown }).subscribe === 'function';

/**
 * Every `mica:<appId>:` key, raw — the frame's sync storage reads come from this.
 *
 * Keys stay **full** (`mica:<appId>:<key>`), not stripped of their prefix: the iframe
 * twin's `storage.ts` reads its cache with `getStorageKey`, which re-adds the same prefix
 * before every `readKey`/`writeKey` call — so a stripped snapshot key never matched what
 * the twin looked up, and every `useStorage`/`usePersisted` read inside an add-on silently
 * fell through to its default value.
 */
function storageSnapshot(appId: string): Record<string, string> {
  const prefix = `mica:${appId}:`;
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

/**
 * How long a frame has to say `hello` after its server is built, before it counts as
 * crashed.
 *
 * The server is built when the `<iframe>` is in the DOM with its `srcdoc` set. By then the
 * bundle is already in memory, fetched and hash-checked by the registry (or fetched whole
 * by `devAddOn.ts` before it registers anything), and `bootAddOn` sends `hello` as its
 * first act. So the honest path is parsing and running one inline script with nothing on
 * the network: tens of milliseconds on a desktop, and a second or two for a large DEV
 * bundle on a slow machine with the game loading. A guest that is still silent after that
 * is not going to speak. A bundle that *throws* before `bootAddOn` is not this case:
 * `srcdocFor` puts a plain-script `error` listener ahead of the module, so that is reported
 * as an `error` message and reaches `onError` on its own. What stays silent is a bundle
 * that never calls `bootAddOn`, one that hangs before it (an `await` that never settles,
 * work that never finishes), or one whose `hello` names another app and is refused.
 * Before this, each of those stayed a blank screen until the player closed the app.
 *
 * Eight seconds is about four times the slowest honest start above. A false trip costs a
 * crash screen with Restart on it; a late one costs only more of the blank screen this
 * replaces, so the window errs long. It is still short enough that the crash screen
 * arrives while the player is waiting for the app, not after they have given up on it.
 * A frozen renderer thread delays this timer along with everything else, so a hitch
 * cannot fire it early, only late.
 *
 * Not reset by a reload. The timer stops at the first accepted `hello`, and a reloaded
 * guest is a later document in a frame that has already started.
 */
export const ADDON_HELLO_TIMEOUT_MS = 8_000;

export function createIframeHostServer(opts: IframeHostServerOptions) {
  const { host, manifest, guest } = opts;
  const post = (msg: ToFrame) => guest()?.postMessage(msg, '*');
  const instances = new Map<string, Record<string, unknown>>();
  const subscriptions = new Map<number, () => void>();
  const handles = new Map<number, (...a: unknown[]) => unknown>();
  /**
   * The handles that are a `call`'s whole return value: the release for whatever that call
   * registered (`lifecycle.onBack`, `keybinds.onKeybind`, `appEvents.on`). `forgetGuest`
   * runs every one the frame did not release itself. A function nested inside a returned
   * object is not here, because nothing guarantees it is a release. A store's `set` has
   * that shape too, and calling it with no argument would clear the store.
   */
  const releases = new Set<number>();
  let nextHandle = 1;
  let disposed = false;
  /**
   * Which guest document a reply or callback belongs to. `forgetGuest` bumps it. Ids start
   * from 1 again in every new document, so a reply or callback left over from the last
   * document would resolve the new one's `await` or run its handler. Anything stamped with
   * an older epoch is dropped instead.
   */
  let guestEpoch = 0;
  const live = (epoch: number) => !disposed && epoch === guestEpoch;
  /**
   * The startup watchdog (`ADDON_HELLO_TIMEOUT_MS`). Cleared by an accepted `hello` or by
   * shutting down.
   */
  let helloTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    helloTimer = undefined;
    if (disposed) return;
    // Shut down before telling the caller, so a `hello` that arrives late, between this
    // and the frame being taken off screen, gets no answer.
    shutDown();
    opts.onError(
      `'${manifest.id}' never started: its frame did not say hello within ` +
        `${ADDON_HELLO_TIMEOUT_MS / 1000}s. Its bundle never calls bootAddOn, or hangs ` +
        `before it does.`,
      null
    );
  }, ADDON_HELLO_TIMEOUT_MS);
  let stopTheme: (() => void) | undefined;
  /** MICA-287: unregisters this frame's `pushStorageToAddOns` callback — see `hydrate()`. */
  let stopAddOnStoragePush: (() => void) | undefined;
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
    // MICA-286. A provider publishes hits under a heading the drawer labels with the app's
    // own name, so an unpinned id would let one add-on put rows under another's name.
    'searchProvider',
    'controlCenter', // MICA-247: a switch shows under its app's name, and only that app's.
    'persisted',
    'deepLink',
    'lifecycle',
    // MICA-235. `catalogs` hands back the strings of whichever app the id names; pinned, it
    // can only ever be this frame's own namespace and `ui`.
    'locale'
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

  /**
   * The same pin for an app id passed as a **call** argument rather than a factory one:
   * `MEMBER_APP_ARGS` in `sdk/permissions.ts`, read through `appIdArgOf`. It lives there
   * beside `FACET_MEMBERS` so that every member a frame can call has to be classified
   * (pinned, deliberately unpinned, or taking no app id) before it compiles.
   */

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
      throw new Error(`[micaOS] '${facet}' is not reachable directly`);
    }
    const allowed = membersOfFacet(facet);
    if (!allowed) {
      throw new Error(`[micaOS] '${facet}' is not reachable from an add-on`);
    }
    if (!allowed.includes(member)) {
      throw new Error(`[micaOS] '${facet}.${member}' is core only`);
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

  /** A call's arguments with any app id in them replaced by the calling app's own. */
  function pinMemberArgs(facet: string, member: string, args: unknown[]): unknown[] {
    const pin = appIdArgOf(facet, member);
    if (!pin) return args;
    const out = [...args];
    // Padded, so an id the frame left out is written in rather than left to default.
    while (out.length <= pin.arg) out.push(undefined);
    if (pin.field) {
      const given = out[pin.arg];
      out[pin.arg] =
        given && typeof given === 'object' && !Array.isArray(given)
          ? { ...given, [pin.field]: host.appId }
          : { [pin.field]: host.appId };
    } else {
      out[pin.arg] = host.appId;
    }
    return out;
  }

  /**
   * MICA-345: a call's **row** ids, narrowed to rows this app owns.
   *
   * The pin above handles an app id. These members name rows instead, and the server
   * scopes a row only by `citizenid`: every row the player owns is in reach, whichever app
   * it belongs to. Ids are sequential, so an add-on could mark read or clear another app's
   * notifications, or rewrite the player's Blabber profile, just by counting. The shell is
   * where the caller's app is known, so the check is here, and only here. A `core: true`
   * app calls the facet in-process and never passes through this server, so nothing it
   * does changes.
   *
   * - `notifications.markRead`/`clear` keep only ids whose notification is this app's. `obj`
   *   is `notifications(host.appId)` (the factory argument is pinned), so its store already
   *   holds just this app's rows; `app` is checked again rather than trusted. Anything but
   *   an array becomes no ids, which the service treats as a no-op. An id for a row the
   *   shade has not loaded is dropped too. That fails closed, and an honest frame only
   *   ever has ids it read from that same store.
   * - `accounts.updateAccount` is refused unless its `id` is one of this app's own accounts,
   *   asked of the server at the time of the call. A failed lookup answers no rows, which
   *   refuses too.
   *
   * Synchronous unless it has to ask, so every other call keeps the reply depth the
   * ordering note in `call` relies on.
   */
  function narrowRows(
    facet: string,
    member: string,
    obj: Record<string, unknown>,
    args: unknown[]
  ): unknown[] | Promise<unknown[]> {
    if (facet === 'notifications' && (member === 'markRead' || member === 'clear')) {
      const items = get(
        obj.notificationsStore as Readable<readonly { id: unknown; app?: unknown }[]>
      );
      const own = new Set(items.filter((n) => n.app === host.appId).map((n) => n.id));
      const ids: unknown[] = Array.isArray(args[0]) ? args[0].filter((id) => own.has(id)) : [];
      return [ids, ...args.slice(1)];
    }
    if (facet === 'accounts' && member === 'updateAccount') {
      const input = args[0];
      const id = input && typeof input === 'object' ? (input as { id?: unknown }).id : undefined;
      const mine = obj.getMyAccounts as (app: string) => Promise<{ rows?: { id: unknown }[] }>;
      return mine(host.appId).then((reply) => {
        if (typeof id !== 'number' || !(reply?.rows ?? []).some((row) => row.id === id)) {
          throw new Error(`[micaOS] '${host.appId}' may only update its own accounts`);
        }
        return args;
      });
    }
    return args;
  }

  /**
   * Resolve (and cache) the facet object for `facet(factoryArgs)`, after the permission
   * check — `host.require` is a no-op for an implicit (`null`) permission, `lifecycle`
   * included, so there is no separate "skip the check" path to maintain (MICA-27).
   */
  function instance(facet: string, factoryArgs: readonly unknown[]): Record<string, unknown> {
    const perm = permissionOfFacet(facet);
    if (!perm) throw new Error(`[micaOS] unknown facet '${facet}'`);
    host.require(perm.needed, perm.hook);
    requireGranted(perm.needed, perm.hook);
    if (facet === 'service' && !serviceAllowed(factoryArgs[0])) {
      throw new Error(
        `[micaOS] '${host.appId}' may only use its own service, not '${String(factoryArgs[0])}'`
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
          `[micaOS] '${host.appId}' has too many live facet instances (${ADDON_LIMITS.instances})`
        );
      }
      const factory = (facets as unknown as Record<string, (...a: unknown[]) => unknown>)[facet];
      obj = factory(...pinnedArgs) as Record<string, unknown>;
      instances.set(key, obj);
    }
    return obj;
  }

  /** Callback refs become live functions, dropped once the document that sent them is gone. */
  const decodeArgs = (args: unknown[], epoch: number): unknown[] => {
    const callback =
      (cb: number) =>
      (...cbArgs: unknown[]) => {
        if (live(epoch)) post({ kind: 'callback', cb, args: cbArgs });
      };
    return args.map((a) => {
      if (isCallbackRef(a)) return callback(a.__cb);
      if (a && typeof a === 'object' && !Array.isArray(a)) {
        return Object.fromEntries(
          Object.entries(a).map(([k, v]) => [k, isCallbackRef(v) ? callback(v.__cb) : v])
        );
      }
      return a;
    });
  };

  /** Run a release, logging rather than throwing: one failure must not stop the rest. */
  const runRelease = (release: (...a: unknown[]) => unknown) => {
    try {
      release();
    } catch (e) {
      console.error(`[micaOS] add-on '${host.appId}' release failed during teardown:`, e);
    }
  };

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

  /**
   * A failed call, as the frame will see it: a name and a message, built field by field so
   * nothing else on the error — its stack, its `cause`, a property a facet hung on it — can
   * cross. Two kinds carry one thing more, each read off a class the shell constructed and
   * never off whatever a thrown object happens to have: an `AppPermissionError` its permission
   * and hook, and a `ServiceRefusal` the catalog key the server named (MICA-310), so the frame
   * rebuilds one and an add-on's `isRefusal(error, key)` answers as a core app's does. The key
   * is the server's, from a reply to a call this frame was only ever allowed to make in its
   * own namespace; the frame has no way to send the shell one.
   */
  const fail = (id: number, e: unknown) =>
    post({
      kind: 'reply',
      id,
      ok: false,
      error:
        e instanceof AppPermissionError
          ? { name: e.name, message: e.message, permission: e.permission, hookName: e.hookName }
          : isRefusal(e)
            ? { name: e.name, message: messageOf(e, 'unknown error'), key: e.key }
            : {
                name: e instanceof Error ? e.name : 'Error',
                message: messageOf(e, 'unknown error')
              }
    });

  async function call(msg: Extract<ToShell, { kind: 'call' }>) {
    // The document asking, so the answer goes to it or to nobody (see `guestEpoch`).
    const epoch = guestEpoch;
    try {
      if (!withinBudget()) {
        throw new Error(
          `[micaOS] '${host.appId}' is calling the shell too fast ` +
            `(over ${ADDON_LIMITS.requestsPerWindow} in ${ADDON_LIMITS.windowMs}ms)`
        );
      }
      requireMember(msg.facet, msg.member);
      const obj = instance(msg.facet, msg.factoryArgs);
      const member = obj[msg.member];
      if (typeof member !== 'function')
        throw new Error(`[micaOS] '${msg.facet}.${msg.member}' is not callable`);
      const pinned = pinMemberArgs(msg.facet, msg.member, decodeArgs(msg.args, epoch));
      const narrowed = narrowRows(msg.facet, msg.member, obj, pinned);
      const args = narrowed instanceof Promise ? await narrowed : narrowed;
      // The check asked the server; the document may have gone while it did. Nothing it
      // asked for is done on its behalf after that.
      if (!live(epoch)) return;
      const value: unknown = await member.apply(obj, args);
      if (!live(epoch)) {
        // Settled after its document went: nobody is left to `invoke` a release, so it is
        // run here, the same as `forgetGuest` runs the ones that were handed out in time.
        if (typeof value === 'function') runRelease(value as (...a: unknown[]) => unknown);
        return;
      }
      const encoded = encodeResult(value);
      if (typeof value === 'function') releases.add((encoded as { __fn: number }).__fn);
      post({ kind: 'reply', id: msg.id, ok: true, value: encoded });
    } catch (e) {
      // A synchronous throw here (unknown facet, missing permission, non-function
      // member) would otherwise settle in the very same tick it was handled in, ahead
      // of an earlier `call` still awaiting its member — so it yields once too, to the
      // same depth an awaited member reply settles at, keeping same-tick calls replying
      // in the order they arrived rather than the order they finished.
      await Promise.resolve();
      if (live(epoch)) fail(msg.id, e);
    }
  }

  function subscribe(msg: Extract<ToShell, { kind: 'subscribe' }>) {
    try {
      if (!withinBudget()) {
        throw new Error(
          `[micaOS] '${host.appId}' is calling the shell too fast ` +
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
          `[micaOS] '${host.appId}' holds too many live subscriptions ` +
            `(${ADDON_LIMITS.subscriptions})`
        );
      }
      requireMember(msg.facet, msg.member);
      const obj = instance(msg.facet, msg.factoryArgs);
      const member = obj[msg.member];
      if (!isStore(member)) throw new Error(`[micaOS] '${msg.facet}.${msg.member}' is not a store`);
      subscriptions.set(
        msg.id,
        member.subscribe((value) => {
          if (!disposed) post({ kind: 'push', id: msg.id, value });
        })
      );
    } catch (e) {
      console.error(`[micaOS] add-on '${host.appId}' subscribe failed:`, e);
    }
  }

  /** Stop answering, permanently. The public `dispose()` and `escaped()` both land here. */
  function shutDown() {
    disposed = true;
    clearTimeout(helloTimer);
    helloTimer = undefined;
    forgetGuest();
  }

  /**
   * Drop everything held on behalf of one guest document, and finish what it started.
   *
   * A release the frame was handed and never invoked is run here. The document that would
   * have invoked it has crashed, reloaded or been torn down, and its registration is a live
   * entry in the shell. A `back` handler left on the keybind stack is the active one for
   * this app id, so Back on the crash screen fired into a frame that was gone. The epoch is
   * bumped first, so a callback a release fires on its way out reaches no document.
   */
  function forgetGuest() {
    guestEpoch += 1;
    stopTheme?.();
    stopTheme = undefined;
    stopAddOnStoragePush?.();
    stopAddOnStoragePush = undefined;
    for (const off of subscriptions.values()) off();
    subscriptions.clear();
    const owed = [...releases].flatMap((h) => handles.get(h) ?? []);
    releases.clear();
    handles.clear();
    instances.clear();
    for (const release of owed) runRelease(release);
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
        `${manifest.name} was built for a different version of micaOS (SDK contract ` +
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
      constants: constantsFor(),
      // Spread only when it says something, so an app frame's payload is byte-for-byte what
      // it was before widgets existed.
      ...(opts.mode === 'widget' ? { mode: 'widget' as const } : {})
    };
    post({ kind: 'hydrate', payload });
    // Started only once a hello is answered: an app that never announces itself never
    // gets a live theme feed, and the first (synchronous) value is already in the
    // hydrate payload above, so a later push is only ever a real change.
    if (!stopTheme) stopTheme = themeStyleStore.subscribe((css) => post({ kind: 'theme', css }));
    /**
     * MICA-287: the character-switch half of the same fix. `storageSnapshot` above is
     * this app's whole local cache, already in the hydrate payload; this is what keeps a
     * *live* frame's copy from going stale after the character changes underneath it —
     * without it, an add-on kept the previous character's values for the rest of the
     * session, the same bug the in-process sweep in `host/facets/storage.ts` fixes for
     * every other app. Guarded the same way as `stopTheme`: registered once per guest
     * document, dropped in `forgetGuest` so a reload or a real teardown does not leave a
     * second, permanently-stale entry behind.
     */
    if (!stopAddOnStoragePush) {
      stopAddOnStoragePush = registerAddOnStoragePush(() =>
        post({ kind: 'storage', snapshot: storageSnapshot(host.appId) })
      );
    }
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
    console.error(`[micaOS] add-on '${manifest.id}': ${detail}. The frame has been shut down.`);
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
            `[micaOS] add-on '${manifest.id}' said hello from a window that is not the one ` +
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
              `[micaOS] add-on frame for '${manifest.id}' announced '${msg.appId}'; refused.`
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
          // The frame started; the watchdog's question is answered.
          clearTimeout(helloTimer);
          helloTimer = undefined;
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
          releases.delete(msg.handle);
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
        case 'ready':
          opts.onReady?.();
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
