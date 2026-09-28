<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  /**
   * MICA-245: a `core: false` add-on's home-screen widget.
   *
   * The same sandbox the app runs in, not a lighter one: `sandbox="allow-scripts"` over the
   * same `srcdocFor` CSP, and an `IframeHostServer` built from the same `hostForApp` host the
   * app frame gets — so the declared permissions, the player's grant, the default-deny facet
   * table, the app-id pin and the rate limits are the app's, and a widget can reach nothing
   * its app could not. The only thing the server is told differently is `mode: 'widget'`,
   * which picks the root `bootAddOn` mounts.
   *
   * What is deliberately *not* the app frame's:
   *
   * - **No input.** The frame is `inert` and `pointer-events-none`: taps land on whatever
   *   the home grid wraps this in, and nothing inside can take focus from the shell, so a
   *   widget can never hold the keyboard or toggle the game's input capture. Its key and
   *   typing messages are dropped here too, because `inert` stops user input, not a script
   *   posting a message.
   * - **No crash screen.** `AppCrashed` is a full-screen sheet with Restart and Home, which a
   *   2x1 cell cannot hold and a home screen should not grow. A widget that errors or
   *   escapes goes blank and says why in the console; opening the app is the recovery.
   * - **No spinner, no background.** A widget cell is transparent until its frame paints.
   * - **A crash-loop breaker.** A widget that hangs the thread while mounting is paused on
   *   the next load rather than booted into the same freeze; `widgetPause.ts` has why.
   *
   * Renders nothing at all unless the manifest says there is a widget at this size, the app
   * is an installed add-on, and its source is in hand — nothing boots speculatively.
   */
  import { onMount, untrack } from 'svelte';
  import type { WidgetSize } from '../../../../sdk/manifest';
  import { hostForApp } from '../../../../sdk/host/inProcess/createInProcessHost';
  import { appRegistryStore } from '../state/registry';
  import { createIframeHostServer } from './IframeHostServer';
  import { srcdocFor } from './srcdoc';
  import { get } from 'svelte/store';
  import { imageHostOrigin } from '../../services/imageHost';
  import { markWidgetBooting, markWidgetSettled, pausedWidgets } from './widgetPause';

  let { appId, size }: { appId: string; size: WidgetSize } = $props();

  // Read through the store so an uninstall, or an owner disabling the app, takes the widget
  // down with it rather than leaving a frame running for an app the player no longer has.
  const manifest = $derived(
    $appRegistryStore && appRegistryStore.isInstalled(appId)
      ? appRegistryStore.getManifest(appId)
      : undefined
  );
  // A widget that hung the phone on an earlier load stays down until it is re-added — see
  // `widgetPause.ts`. The home grid reads the same store to draw "Widget paused".
  const offered = $derived(
    !$pausedWidgets.has(appId) &&
      manifest !== undefined &&
      manifest.core === false &&
      (manifest.widget?.sizes.includes(size) ?? false)
  );

  /**
   * The server's image host for this frame's `img-src` (MICA-243), read once when the
   * document is built and deliberately not subscribed: a changed `srcdoc` is a second
   * document load, which the host treats as a navigation and tears the frame down for.
   * The answer lands at boot, well before any add-on is opened.
   */
  const imageHosts = (): string[] => {
    const origin = untrack(() => get(imageHostOrigin));
    return origin ? [origin] : [];
  };

  let source = $state<string | undefined>();
  let stopped = $state(false);
  let frame = $state<HTMLIFrameElement | undefined>();
  let server = $state<ReturnType<typeof createIframeHostServer>>();
  /** Documents this element has loaded — the same navigate-away rule as `AddOnFrame`. */
  let loadsSeen = 0;

  onMount(() => {
    void appRegistryStore.getAddOnSource(appId).then((s) => (source = s));
  });

  function handleLoad() {
    loadsSeen += 1;
    if (loadsSeen < 2) return;
    console.error(
      `[micaOS] add-on '${appId}' widget loaded a second document into its frame; it has ` +
        `navigated away from its own bundle. The widget has been shut down.`
    );
    server?.dispose();
    stopped = true;
  }

  /** A resize pushes the new size into the running widget rather than rebuilding it. */
  $effect(() => {
    const s = size;
    server?.pushProps({ size: s });
  });

  /**
   * Depends on `frame`, `source` and `offered` alone; the manifest and size are read
   * untracked, for the reason `AddOnFrame`'s own effect gives — the frame sends one `hello`,
   * so a server rebuilt on an identity change would never be introduced to it again.
   */
  $effect(() => {
    const el = frame;
    if (!el || !source || !offered) return;
    loadsSeen = 0;
    // Before the srcdoc can run a line: a frame that freezes the thread never clears this.
    markWidgetBooting(appId);

    const built = untrack(() => {
      const m = manifest!;
      return createIframeHostServer({
        host: hostForApp(appId, m),
        manifest: m,
        props: { size },
        mode: 'widget',
        guest: () => el.contentWindow,
        // A crash or an escape is the thread coming back, not a hang: settle the marker so
        // the widget is blank this time rather than paused for good.
        onError: (message) => {
          console.error(`[micaOS] add-on '${appId}' widget crashed:`, message);
          markWidgetSettled(appId);
          stopped = true;
        },
        onEscape: () => {
          markWidgetSettled(appId);
          stopped = true;
        },
        onReady: () => markWidgetSettled(appId),
        onKey: () => {},
        onTyping: () => {}
      });
    });
    window.addEventListener('message', built.handle);
    server = built;
    return () => {
      window.removeEventListener('message', built.handle);
      built.dispose();
      server = undefined;
      // Torn down in order — unmounted, resized away, uninstalled — so it did not hang.
      markWidgetSettled(appId);
    };
  });
</script>

{#if offered && source && !stopped && manifest}
  <iframe
    bind:this={frame}
    title={manifest.name}
    data-widget={appId}
    data-size={size}
    sandbox="allow-scripts"
    srcdoc={srcdocFor(source, manifest.networkHosts, imageHosts())}
    onload={handleLoad}
    tabindex="-1"
    inert
    class="pointer-events-none h-full w-full border-0 bg-transparent"
  ></iframe>
{/if}
