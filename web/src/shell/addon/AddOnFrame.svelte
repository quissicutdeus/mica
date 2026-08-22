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

  onMount(() => {
    void appRegistryStore.getAddOnSource(appId).then((s) => (source = s));
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
   * value that changes *after* mount, from a deep link into an already-open add-on,
   * is out of scope here; it would need its own push message to the frame, not a
   * server rebuild — left for a follow-up.)
   */
  $effect(() => {
    const el = frame;
    const src = source;
    if (!el || !src) return;
    const win = el.contentWindow;
    if (!win) return;

    const server = untrack(() =>
      createIframeHostServer({
        host,
        manifest,
        props,
        target: win,
        source: win,
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
        onTyping
      })
    );
    window.addEventListener('message', server.handle);
    return () => {
      window.removeEventListener('message', server.handle);
      server.dispose();
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
      srcdoc={srcdocFor(source)}
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
