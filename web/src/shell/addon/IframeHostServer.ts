import { get } from 'svelte/store';
import type { Host } from '../../sdk/host/protocol';
import { AppPermissionError } from '../../sdk/host/protocol';
import { facets } from '../../sdk/host/current';
import { permissionOfFacet } from '../../sdk/permissions';
import type { AppManifest } from '../../sdk/manifest';
import type {
  ToFrame,
  ToShell,
  HydratePayload,
  AddOnConstants
} from '../../sdk/host/iframe/messages';
import { isCallbackRef } from '../../sdk/host/iframe/messages';
import { themeStyleStore } from '../state/theme';
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

/** Every `gphone:<appId>:` key, raw — the frame's sync storage reads come from this. */
function storageSnapshot(appId: string): Record<string, string> {
  const prefix = `gphone:${appId}:`;
  const out: Record<string, string> = {};
  if (typeof localStorage === 'undefined') return out;
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith(prefix)) out[key.slice(prefix.length)] = localStorage.getItem(key) ?? '';
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
    theme: { defaultTheme: t.defaultTheme }
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

  /** Resolve (and cache) the facet object for `facet(factoryArgs)`, after the permission check. */
  function instance(facet: string, factoryArgs: readonly unknown[]): Record<string, unknown> {
    const perm = permissionOfFacet(facet);
    if (!perm) throw new Error(`[gPhone] unknown facet '${facet}'`);
    host.require(perm.needed, perm.hook);
    if (facet === 'service' && !serviceAllowed(factoryArgs[0])) {
      throw new Error(
        `[gPhone] '${host.appId}' may only use its own service, not '${String(factoryArgs[0])}'`
      );
    }
    const key = `${facet}:${JSON.stringify(factoryArgs)}`;
    let obj = instances.get(key);
    if (!obj) {
      const factory = (facets as unknown as Record<string, (...a: unknown[]) => unknown>)[facet];
      obj = factory(...factoryArgs) as Record<string, unknown>;
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
      const obj = instance(msg.facet, msg.factoryArgs);
      const member = obj[msg.member];
      if (typeof member !== 'function')
        throw new Error(`[gPhone] '${msg.facet}.${msg.member}' is not callable`);
      const value = await member.apply(obj, decodeArgs(msg.args));
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
      permissions: host.permissions,
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
          if (!msg.manifest || msg.manifest.id !== manifest.id) {
            console.error(
              `[gPhone] add-on frame for '${manifest.id}' announced '${msg.manifest?.id}'; refused.`
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
    }
  };
}
