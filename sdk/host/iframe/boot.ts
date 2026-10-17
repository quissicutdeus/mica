// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * MICA-176. **First import, deliberately** — the add-on's half of the SDK host seam, and
 * the mirror of `src/main.ts`'s first line. Every `sdk/host/iframe/facets/*` twin
 * self-registers into `sdk/host/current.ts`'s registry from here, so an add-on bundle
 * resolves its facets by having imported this file rather than by a build alias rewriting
 * each hook's specifier. `sdk/host/inProcess/**` is not reachable from this graph at all,
 * which `seam.test.ts` checks by resolving specifiers to real paths.
 */
import './registerFacets';
/**
 * MICA-172: installs this bundle's `fetchNui` (the `postMessage` twin) into the SDK's
 * transport seam. Explicit rather than left to whatever a facet happens to pull in, for the
 * same reason the facet set is explicit: an entry point choosing is the whole design.
 */
import './fetchNui';
import { mount, unmount } from 'svelte';
import { clientTransport } from './transport';
import { remoteStore } from './remote';
import { createInProcessHost } from '../inProcess/createInProcessHost';
import { registerHost, setSystemHost } from '../current';
import { HOST_CONTEXT_KEY } from '../protocol';
import { hydrateStorage } from './storageCache';
import { setConstants } from './constants';
import { lifecycle } from './facets/lifecycle';
import { locale } from './facets/locale';
import {
  liveAddOnProps,
  liveWidgetProps,
  setLiveAddOnProps,
  setLiveWidgetProps
} from './liveProps.svelte';
import type { Component } from 'svelte';
import type { AppComponent, AppManifest, WidgetSize } from '../../manifest';
import type { DeviceId } from '@mica/shared/devices';

// MICA-16 step 4: the add-on's entry point, called by the bundle every add-on ships
// instead of the shell mounting it in-process. Wires the transport, waits for hydrate,
// then mounts the app with the same host protocol it would get inside the shell.

const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (TYPING_TAGS.has(t.tagName) || t.isContentEditable);

/**
 * Keys and focus, forwarded to the shell. Attached before `hello`, so a phone-level key
 * pressed while the app frame is still hydrating is not swallowed; the returned function
 * stops it, which a widget frame does the moment hydrate says that is what it is. A widget
 * sits on the home screen behind nothing — it is never what the player is typing into — so
 * it has no business replaying keybinds or toggling the game's input capture (MICA-245).
 */
function forwardInput(transport: ReturnType<typeof clientTransport>): () => void {
  let on = true;
  window.addEventListener('keydown', (e) => {
    if (!on) return;
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
    if (on && isTyping(e.target)) transport.send({ kind: 'typing', typing: true });
  });
  window.addEventListener('focusout', (e) => {
    if (on && isTyping(e.target)) transport.send({ kind: 'typing', typing: false });
  });
  return () => {
    on = false;
  };
}

function applyTheme(css: string) {
  // The same `--color-*:` block PhoneFrame puts on the screen element, on this document's root.
  document.documentElement.setAttribute('style', css);
}

/**
 * The optional roots a bundle ships beside its app (MICA-245). An object rather than more
 * positional arguments, so each new root is another key and not a parameter every caller
 * has to count to.
 */
interface BootRoots {
  /**
   * The home-screen widget, mounted instead of `App` when the shell boots this bundle in a
   * widget frame. Declare `widget: { sizes }` on the manifest too: nothing else tells the
   * shell there is one to boot.
   */
  widget?: Component<{ size: WidgetSize }>;
  /**
   * The root for the tablet frame (MICA-265), mounted instead of `App` while the device on
   * screen is the tablet. It gets the same props `App` does, deep links included, and
   * swaps with `App` if the device changes under a running frame, as a core app's
   * `tablet.svelte` does.
   *
   * Which device that is comes from `useDisplay().device`, so the manifest declares the
   * `display` permission and lists `'tablet'` in `devices`. Without `display` this root is
   * never mounted and `App` is drawn on every device, stretched to the frame on the
   * tablet, as it would be with no tablet root at all.
   */
  tablet?: AppComponent;
}

/**
 * How long a frame with a tablet root waits for the shell to say which device it is on
 * before drawing `App` anyway.
 *
 * The answer is the first push on `display.device`, normally one round trip. A shell that
 * predates that member (MICA-260) refuses the subscription without a reply, and a shell
 * cannot be asked which members it has, so the wait is bounded rather than open: a blank
 * frame forever is worse than the phone root on a tablet. A push that lands after this
 * still swaps to the right root.
 */
const DEVICE_WAIT_MS = 1000;

/**
 * Mount `App` or `tablet` by the device on screen, and swap them if it changes.
 *
 * Read over the `display` facet's `device` store rather than a new field on the hydrate
 * payload: that store is what `useDisplay().device` already reads, so the shell has one
 * answer to give, an app reading it from its own code shares this wire, and the shell
 * re-checks the `display` permission on it like on any other subscription.
 */
function mountByDevice(
  App: AppComponent,
  tablet: AppComponent,
  permissions: readonly string[],
  appId: string,
  mountRoot: (root: AppComponent) => ReturnType<typeof mount>
): void {
  let shown: { root: AppComponent; instance: ReturnType<typeof mount> } | undefined;
  const show = (root: AppComponent) => {
    if (shown?.root === root) return;
    if (shown) void unmount(shown.instance);
    shown = { root, instance: mountRoot(root) };
  };

  if (!permissions.includes('display')) {
    // Not an error: `App` on a tablet is what an app without a tablet root gets. The
    // add-on builds refuse a tablet root without `display` declared, so this is a grant
    // that did not include it, and the player still gets a working app.
    console.warn(
      `[micaOS] add-on '${appId}' passed a tablet root but holds no 'display' permission, ` +
        `so it cannot learn which device it is on. Its app root is drawn on every device.`
    );
    show(App);
    return;
  }

  const fallback = setTimeout(() => {
    if (!shown) show(App);
  }, DEVICE_WAIT_MS);
  // `undefined` until the shell's first push, which the default `display().device` seed
  // (`'phone'`) would hide: mounting the phone root first and swapping it a round trip
  // later would run its `onAppForeground` load for nothing on every tablet open.
  remoteStore<DeviceId | undefined>('display', [], 'device', undefined).subscribe((device) => {
    if (device === undefined) return;
    clearTimeout(fallback);
    show(device === 'tablet' ? tablet : App);
  });
}

export async function bootAddOn(
  manifest: AppManifest,
  App: AppComponent,
  roots: BootRoots = {}
): Promise<void> {
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
  const stopForwarding = forwardInput(transport);

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
  // MICA-235: follow the shell's language and its catalogs before the first paint, not
  // only once the add-on happens to call `useLocale()`. The SDK primitives and an app's
  // own `$t` read the bundle's `locale` directly, so a frame that never asked stayed in
  // English whatever the player chose.
  locale();

  const target = document.getElementById('app') ?? document.body;
  const context = new Map([[HOST_CONTEXT_KEY, host]]);

  if (payload.mode === 'widget') {
    stopForwarding();
    // Reported rather than falling back to the app root: an app squeezed into a 2x1 cell
    // is not a widget, and the shell shows nothing for a frame that errors.
    if (!roots.widget) {
      transport.send({
        kind: 'error',
        message: `add-on '${payload.appId}' was booted as a widget but passed no widget root`,
        stack: null
      });
      return;
    }
    setLiveWidgetProps(payload.props);
    transport.onProps(setLiveWidgetProps);
    mount(roots.widget, { target, props: liveWidgetProps, context });
    transport.send({ kind: 'ready' });
    return;
  }

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

  const mountRoot = (root: AppComponent) => mount(root, { target, props: liveAddOnProps, context });
  if (roots.tablet) {
    mountByDevice(App, roots.tablet, payload.permissions, payload.appId, mountRoot);
    return;
  }
  mountRoot(App);
}
