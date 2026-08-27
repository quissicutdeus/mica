<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import type { AppManifest } from '../../sdk/manifest';
  import type { Host } from '../../sdk/host/protocol';
  import { appRegistryStore } from '../state/registry';
  import { createIframeHostServer } from './IframeHostServer';
  import { srcdocFor } from './srcdoc';
  import { goHome } from '../state/navigation';
  import AppCrashed from '../AppCrashed.svelte';

  let {
    appId,
    manifest,
    host,
    props,
    active,
    onKey,
    onTyping
  }: {
    appId: string;
    manifest: AppManifest;
    host: Host;
    props: Record<string, unknown>;
    /** Whether this add-on is the app on screen. Only the active one may inject keys. */
    active: boolean;
    onKey: (k: {
      key: string;
      code: string;
      ctrlKey: boolean;
      shiftKey: boolean;
      altKey: boolean;
      metaKey: boolean;
      typing: boolean;
    }) => void;
    onTyping: (typing: boolean) => void;
  } = $props();

  let source = $state<string | undefined>();
  let crashed = $state<{ message: string; stack: string | null } | null>(null);
  let generation = $state(0); // re-keys the iframe on Restart
  let frame = $state<HTMLIFrameElement | undefined>();
  // Whether this frame's last forwarded report was `typing: true` — tracked so a
  // frame backgrounded mid-type doesn't strand `setTyping(true)` forever, since it
  // never gets a DOM blur of its own to send the matching `false`.
  let lastTypingSent = $state(false);
  // The live server, once built below — `$state` so the props-push effect further down
  // re-evaluates the moment it becomes available, in case a deep link updates `props`
  // before the frame has finished loading (see that effect's own comment).
  let server = $state<ReturnType<typeof createIframeHostServer>>();

  onMount(() => {
    void appRegistryStore.getAddOnSource(appId).then((s) => (source = s));
  });

  $effect(() => {
    if (active || !lastTypingSent) return;
    lastTypingSent = false;
    onTyping(false);
  });

  /**
   * MICA-25: a deep link into an add-on that is already open changes `props` (a new
   * object from `openApp`'s merge — see `shell/state/navigation.ts`) without remounting
   * this component, since apps are resident. The effect below deliberately does not react
   * to `props` — rebuilding the server on every identity change would mean the frame's one
   * `hello` never gets answered again — so this is the one place `props` *is* tracked, to
   * forward the update over the wire instead. Reading `server` too means this also fires
   * once the frame finishes loading if a deep link happened to land before it did.
   */
  $effect(() => {
    const p = props;
    server?.pushProps(p);
  });

  /**
   * Depends on `frame` and `source` alone.
   *
   * Every other value the server needs — `host`, `manifest`, `props`, `onKey`,
   * `onTyping`, `appId` — is read through `untrack`, deliberately: reading any of them
   * normally would make this effect re-run whenever *that* value's identity changed,
   * and `props` gets a brand-new object on every `openApp` call. A resident add-on
   * would then have its live server disposed and rebuilt on every re-open, bound to an
   * iframe that already ran its one `hello` and has no way to send another — the frame
   * would go permanently deaf and blind to hydrate/theme/storage pushes. (A `props`
   * value that changes *after* mount, from a deep link into an already-open add-on, is
   * handled by the effect above instead, over its own `props` push message.)
   */
  $effect(() => {
    const el = frame;
    const src = source;
    if (!el || !src) return;

    const built = untrack(() =>
      createIframeHostServer({
        host,
        manifest,
        props,
        /**
         * MICA-90: the frame is asked who it is running on every message, rather than
         * handing the server one window and hoping it stays the one in there.
         *
         * The `load`-driven rebind this replaces could not work, and the log line it left
         * behind pointed at itself for the recovery. A frame's scripts run before its
         * `load` fires, so a reloaded guest posts its one and only `hello` while the host
         * is still bound to the old window: refused, and then rebound a step later to a
         * window that will never introduce itself again. The add-on stayed blank, alive
         * and talking to nobody. Reading `contentWindow` here instead makes the reloaded
         * frame's first `hello` land, with nothing to rebuild and no ordering to lose.
         */
        guest: () => el.contentWindow,
        onError: (message, stack) => {
          console.error(`[gPhone] add-on '${appId}' crashed:`, message);
          crashed = { message, stack };
        },
        /**
         * A backgrounded add-on is `display:none` and `inert`, but its iframe keeps
         * running — timers, listeners and all — and `postMessage` is not gated by any of
         * that. Without this check a resident add-on sitting behind another app could send
         * `key` messages that `Shell`'s `handleFrameKey` replays as real shell keybinds:
         * Backspace to walk the foreground app back, Escape to close the phone, arrow keys
         * into whatever has focus. So the shell decides who is talking, not the frame.
         *
         * `active` is read here, at delivery, rather than captured when the server was
         * built — the `untrack` above deliberately freezes the effect's other reads, and a
         * captured boolean would pin this to whatever was true at mount and never change.
         * `$props()` values are live getters, so reading one inside a callback is current.
         */
        onKey: (k) => {
          if (active) onKey(k);
        },
        // Gated the same way as `onKey` above, for the same reason: a backgrounded
        // frame keeps running and `postMessage` isn't gated by `inert`/`display:none`,
        // so an unchecked `typing` message would let it toggle the player's game-input
        // capture at will.
        onTyping: (typing) => {
          if (!active) return;
          lastTypingSent = typing;
          onTyping(typing);
        }
      })
    );
    window.addEventListener('message', built.handle);
    server = built;
    return () => {
      window.removeEventListener('message', built.handle);
      built.dispose();
      server = undefined;
    };
  });
</script>

{#if crashed}
  <AppCrashed
    appName={manifest.name}
    message={crashed.message}
    stack={crashed.stack}
    onRestart={() => {
      crashed = null;
      generation += 1;
    }}
    onHome={() => {
      crashed = null;
      generation += 1;
      goHome();
    }}
  />
{:else if source}
  {#key generation}
    <iframe
      bind:this={frame}
      title={manifest.name}
      data-app={appId}
      sandbox="allow-scripts"
      srcdoc={srcdocFor(source, manifest.networkHosts)}
      class="h-full w-full border-0 bg-transparent"
    ></iframe>
  {/key}
{:else}
  <div class="bg-surface flex h-full w-full items-center justify-center">
    <div
      class="border-outline-variant border-t-primary h-8 w-8 animate-spin rounded-full border-2"
    ></div>
  </div>
{/if}
