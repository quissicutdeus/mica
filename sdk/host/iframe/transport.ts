// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ToFrame, ToShell, HydratePayload } from './messages';

// MICA-16 step 4: the iframe's one door to the shell — a single postMessage channel to
// window.parent, with reply/push/callback/theme/storage routing over it.

export interface ClientTransport {
  send(msg: ToShell): void;
  /** Resolves with the hydrate payload the shell sends once it has created the server. */
  hydrated(): Promise<HydratePayload>;
  onReply(id: number, cb: (msg: Extract<ToFrame, { kind: 'reply' }>) => void): void;
  onPush(id: number, cb: (value: unknown) => void): () => void;
  registerCallback(fn: (...args: unknown[]) => unknown): number;
  /** Drop a registered callback by the same function reference `registerCallback` was given. */
  releaseCallback(fn: (...args: unknown[]) => unknown): void;
  onTheme(cb: (css: string) => void): void;
  onStorage(cb: (snapshot: Record<string, string>) => void): void;
  /** A deep link into an already-running add-on — see `liveProps.svelte.ts`. */
  onProps(cb: (props: Record<string, unknown>) => void): void;
}

/** Build the transport over `window.parent`. Messages whose `source !== window.parent` are dropped. */
export function createClientTransport(win: Window = window): ClientTransport {
  const replies = new Map<number, (m: Extract<ToFrame, { kind: 'reply' }>) => void>();
  const pushes = new Map<number, (v: unknown) => void>();
  const callbacks = new Map<number, (...a: unknown[]) => unknown>();
  // MICA-23: lets `releaseCallback` find a registration by the same function reference
  // the caller already holds (the handler passed to onBack/onKeybind/appEvents.on), rather
  // than threading the id back out through `encodeArgs`. Weak so a callback that is simply
  // dropped without ever calling `releaseCallback` (a bug elsewhere) can't itself pin memory.
  const callbackIds = new WeakMap<(...a: unknown[]) => unknown, number>();
  const themeCbs = new Set<(css: string) => void>();
  const storageCbs = new Set<(s: Record<string, string>) => void>();
  const propsCbs = new Set<(p: Record<string, unknown>) => void>();
  let nextCb = 1;
  let resolveHydrate: (p: HydratePayload) => void = () => {};
  const hydrate = new Promise<HydratePayload>((r) => (resolveHydrate = r));

  win.addEventListener('message', (event: MessageEvent) => {
    // The one window this frame trusts. Anything else — a sibling frame, an extension —
    // is dropped before its shape is even looked at.
    if (event.source !== win.parent) return;
    const msg = event.data as ToFrame;
    if (!msg || typeof msg !== 'object' || typeof msg.kind !== 'string') return;
    switch (msg.kind) {
      case 'hydrate':
        resolveHydrate(msg.payload);
        break;
      case 'reply':
        replies.get(msg.id)?.(msg);
        replies.delete(msg.id);
        break;
      case 'push':
        pushes.get(msg.id)?.(msg.value);
        break;
      case 'callback':
        callbacks.get(msg.cb)?.(...msg.args);
        break;
      case 'theme':
        for (const cb of themeCbs) cb(msg.css);
        break;
      case 'storage':
        for (const cb of storageCbs) cb(msg.snapshot);
        break;
      case 'props':
        for (const cb of propsCbs) cb(msg.props);
        break;
    }
  });

  return {
    send: (msg) => win.parent.postMessage(msg, '*'),
    hydrated: () => hydrate,
    onReply: (id, cb) => {
      replies.set(id, cb);
    },
    onPush: (id, cb) => {
      pushes.set(id, cb);
      return () => pushes.delete(id);
    },
    registerCallback: (fn) => {
      const id = nextCb++;
      callbacks.set(id, fn);
      callbackIds.set(fn, id);
      return id;
    },
    releaseCallback: (fn) => {
      const id = callbackIds.get(fn);
      if (id === undefined) return;
      callbacks.delete(id);
      callbackIds.delete(fn);
    },
    onTheme: (cb) => {
      themeCbs.add(cb);
    },
    onStorage: (cb) => {
      storageCbs.add(cb);
    },
    onProps: (cb) => {
      propsCbs.add(cb);
    }
  };
}

let current: ClientTransport | undefined;
export function setClientTransport(t: ClientTransport): void {
  current = t;
}
/**
 * The single transport `remote.ts` uses. Lazily created (and cached) against `window` on
 * first use: the addon-entry bundle imports the app's own module graph (and therefore
 * runs any module-scope `useAppEvents(...).on(...)` subscription it makes — see
 * `apps/blabber/store.ts`) before `bootAddOn()` gets a chance to call `setClientTransport`.
 * A `call`/`subscribe` sent this early is fine: the server answers it without a `hello`.
 * `setClientTransport` still lets a test (or `bootAddOn`, which reuses whatever is already
 * set) install a specific instance ahead of time.
 */
export function clientTransport(): ClientTransport {
  if (!current) current = createClientTransport();
  return current;
}
