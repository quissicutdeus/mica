/**
 * MICA-176. **First import, deliberately** — the add-on's half of the SDK host seam, and
 * the mirror of `src/main.ts`'s first line. Every `sdk/host/iframe/facets/*` twin
 * self-registers into `sdk/host/current.ts`'s registry from here, so an add-on bundle
 * resolves its facets by having imported this file rather than by a build alias rewriting
 * each hook's specifier. `sdk/host/inProcess/**` is not reachable from this graph at all,
 * which `seam.test.ts` checks by resolving specifiers to real paths.
 */
import './registerFacets';
import { mount } from 'svelte';
import { clientTransport } from './transport';
import { createInProcessHost } from '../inProcess/createInProcessHost';
import { registerHost, setSystemHost } from '../current';
import { HOST_CONTEXT_KEY } from '../protocol';
import { hydrateStorage } from './storageCache';
import { setConstants } from './constants';
import { lifecycle } from './facets/lifecycle';
import { liveAddOnProps, setLiveAddOnProps } from './liveProps.svelte';
import type { AppComponent, AppManifest } from '../../manifest';

// MICA-16 step 4: the add-on's entry point, called by the bundle every add-on ships
// instead of the shell mounting it in-process. Wires the transport, waits for hydrate,
// then mounts the app with the same host protocol it would get inside the shell.

const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (TYPING_TAGS.has(t.tagName) || t.isContentEditable);

function applyTheme(css: string) {
  // The same `--color-*:` block PhoneFrame puts on the screen element, on this document's root.
  document.documentElement.setAttribute('style', css);
}

export async function bootAddOn(manifest: AppManifest, App: AppComponent): Promise<void> {
  const transport = clientTransport();

  window.addEventListener('error', (e) =>
    transport.send({
      kind: 'error',
      message: e.message,
      stack: e.error instanceof Error ? (e.error.stack ?? null) : null
    })
  );
  window.addEventListener('unhandledrejection', (e) =>
    transport.send({
      kind: 'error',
      message: e.reason instanceof Error ? e.reason.message : String(e.reason),
      stack: e.reason instanceof Error ? (e.reason.stack ?? null) : null
    })
  );
  window.addEventListener('keydown', (e) => {
    // A held key repeat-fires `keydown` with no `repeat` flag on the wire message —
    // `routeKey` on the shell side drops `event.repeat` for the real listener, but a
    // synthetic `KeyboardEvent` it rebuilds from this message is never "held" in that
    // sense, so a repeat sent from here would fire the bound action on every repaint
    // instead of once on the initial press. Drop it at the source instead of widening
    // the wire schema for a bit the shell side would just re-derive as always-false.
    if (e.repeat) return;
    transport.send({
      kind: 'key',
      key: e.key,
      code: e.code,
      ctrlKey: e.ctrlKey,
      shiftKey: e.shiftKey,
      altKey: e.altKey,
      metaKey: e.metaKey,
      typing: isTyping(e.target)
    });
  });
  window.addEventListener('focusin', (e) => {
    if (isTyping(e.target)) transport.send({ kind: 'typing', typing: true });
  });
  window.addEventListener('focusout', (e) => {
    if (isTyping(e.target)) transport.send({ kind: 'typing', typing: false });
  });

  transport.send({ kind: 'hello', appId: manifest.id });
  const payload = await transport.hydrated();

  applyTheme(payload.theme);
  transport.onTheme(applyTheme);
  hydrateStorage(payload.storage);
  transport.onStorage(hydrateStorage);
  setConstants(payload.constants);

  // Inside the frame the app *is* the system: store-scope hooks (blabber/store.ts) fall back to
  // this host, and the context lookup finds the same one. Permissions here are a courtesy
  // fail-fast; the shell's server re-checks every call.
  const host = createInProcessHost(payload.appId, payload.permissions);
  registerHost(host);
  setSystemHost(host);

  // `onback` lives outside `setLiveAddOnProps`'s tracked keys deliberately (see
  // `liveProps.svelte.ts`) — it is host-owned and must survive every deep-link props push,
  // not just the first.
  liveAddOnProps.onback = () => void lifecycle(payload.appId).goHome();
  setLiveAddOnProps(payload.props);
  // MICA-25: re-opening an already-running add-on by a new deep link pushes updated
  // props over the wire rather than remounting the frame — `AddOnFrame.svelte` never tore
  // down and rebuilt the server for a `props` identity change, so there was previously no
  // way for a second deep link to reach an app that was already open.
  transport.onProps(setLiveAddOnProps);

  const target = document.getElementById('app') ?? document.body;
  mount(App, {
    target,
    props: liveAddOnProps,
    context: new Map([[HOST_CONTEXT_KEY, host]])
  });
}
