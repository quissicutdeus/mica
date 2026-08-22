import { get } from 'svelte/store';
import type { Host } from '../../sdk/host/protocol';
import { AppPermissionError } from '../../sdk/host/protocol';
import { facets } from '../../sdk/host/current';
import { permissionOfFacet, DENIED_FACETS } from '../../sdk/permissions';
import type { AppManifest } from '../../sdk/manifest';
import type {
  ToFrame,
  ToShell,
  HydratePayload,
  AddOnConstants
} from '../../sdk/host/iframe/messages';
import { isCallbackRef } from '../../sdk/host/iframe/messages';
import { themeStyleStore } from '../state/theme';
import { is24Hour } from '../state/time';
import { messageOf } from '../../lib/errors';

export interface IframeHostServerOptions {
  host: Host;
  manifest: AppManifest;
  props: Record<string, unknown>;
  target: { postMessage(msg: ToFrame, origin: string): void };
  /** What `event.source` must equal for a message to be accepted. */
  source: unknown;
  onError(message: string, stack: string | null): void;
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
  const { host, manifest, target, source } = opts;
  const post = (msg: ToFrame) => target.postMessage(msg, '*');
  const instances = new Map<string, Record<string, unknown>>();
  const subscriptions = new Map<number, () => void>();
  const handles = new Map<number, (...a: unknown[]) => unknown>();
  let nextHandle = 1;
  let disposed = false;
  let stopTheme: (() => void) | undefined;

  const serviceAllowed = (id: unknown) =>
    typeof id === 'string' && (id === host.appId || id.startsWith(`${host.appId}_`));

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

  /**
   * Members an add-on may reach on a facet that is otherwise core-only.
   *
   * `appRegistry` is the whole reason this exists: `permissionOfFacet` gates the facet,
   * not the member, so an add-on holding `app-registry` (the Store declares it, and a
   * Store-installed add-on may declare it too) could call `installFromCatalog`,
   * `registerAddOn` or `unregisterApp` and install or delete apps. The iframe twin refuses
   * those locally, but the twin is code inside the sandbox — a raw `postMessage` skips it
   * entirely, which is exactly the boundary this server is.
   *
   * A facet absent from this table is unrestricted; a facet present in it exposes only the
   * members listed.
   */
  const MEMBER_ALLOWLIST: Partial<Record<string, readonly string[]>> = {
    appRegistry: ['registryStore', 'getFirstBootTime']
  };

  // `DENIED_FACETS` is imported from `sdk/permissions.ts`, not declared here (MICA-33):
  // see that file's doc comment for which facets and why. It used to be a local set with
  // a second, independently hand-typed copy in `IframeHostServer.test.ts` — two places the
  // same five names had to agree, with nothing checking that they did, or that a sixth
  // bare-function facet ever gets added to either. `permissions.test.ts` now proves every
  // *implicit* facet is classified as this shape or the safe one; a facet that instead
  // requires a real permission (`clearAppStorage`/`appStorageBytes`) is denied here for
  // the same shape reason but needs no such proof, since its permission already gates it.

  /** Throws unless `member` is reachable on `facet` from inside the sandbox. */
  function requireMember(facet: string, member: string): void {
    if (DENIED_FACETS.has(facet)) {
      throw new Error(`[gPhone] '${facet}' is not reachable directly`);
    }
    const allowed = MEMBER_ALLOWLIST[facet];
    if (allowed && !allowed.includes(member)) {
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
      const value = await member.apply(obj, args);
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

  return {
    handle(event: MessageEvent) {
      if (disposed || event.source !== source) return;
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
          handles.get(msg.handle)?.(...msg.args);
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
      disposed = true;
      stopTheme?.();
      for (const off of subscriptions.values()) off();
      subscriptions.clear();
      handles.clear();
      instances.clear();
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
