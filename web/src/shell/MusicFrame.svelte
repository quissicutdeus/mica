<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  /**
   * One YouTube player element, and the only place the phone owns one. MICA-111.
   *
   * Phase 1 put a single embed in `MusicPlayer.svelte` because there was a single thing to
   * play. Phase 2 adds other people's music, and that is genuinely a different concept —
   * no queue, no seek, no repeat, not yours to control (`state/nearbyMusic.ts` says why it
   * is a separate module rather than a flag). What the two share is not their *state*, it
   * is this: a cross-origin frame that has to be created, handshaken, addressed and torn
   * down exactly right, with a security posture that took a page of reasoning to arrive at.
   *
   * So the element moved here and the two consumers stayed apart. `MusicPlayer.svelte`
   * drives one of these with the full transport; `NearbyMusicFrame.svelte` drives one with
   * a volume and nothing else. Neither knows how the other works, and there is one copy of
   * the sandbox attributes, the handshake, and the origin check — which is the half where
   * a divergence would be a vulnerability rather than a bug.
   *
   * ## The embed decision, and what it accepts
   *
   * There are two ways to drive a YouTube embed, and this file takes the second.
   *
   * **Not taken: the IFrame Player API.** `<script src="https://www.youtube.com/iframe_api">`
   * is the documented route, it hands you `player.playVideo()` and typed events, and it is
   * unambiguously less work. It also executes Google's JavaScript **in the shell's own
   * origin**, next to `window.invokeNative`. AGENTS.md §7 is specific about what that
   * means here: injected script in CEF can `fetch` any registered NUI callback, including
   * ones with server-side effects, so script execution in this page is privilege
   * escalation rather than defacement. `iframe_api` is additionally a loader — the code
   * that ends up running is `www-widgetapi.js`, fetched at runtime, versioned by Google
   * and not by us, on every player's client. Accepting that would mean accepting that
   * whatever Google ships tomorrow inherits the phone's full NUI reach, forever, and no
   * review of ours ever sees it.
   *
   * **Taken: a plain cross-origin iframe, driven by `postMessage`.** The frame below runs
   * the same player, but in `youtube-nocookie.com`'s origin, so the same-origin policy —
   * the browser's boundary, not our discipline — keeps it away from this document, its
   * storage, and the NUI bridge. The commands sent to it are the IFrame API's own wire
   * format (`{ event: 'command', func, args }`); we speak the protocol without hosting the
   * speaker.
   *
   * What that costs, stated plainly:
   * - The command protocol is not a documented public API. If YouTube changes it, the
   *   phone loses *control of the player* — it does not lose the security boundary, and
   *   the failure is recoverable by fixing this file.
   * - No typed events. State comes back as `onStateChange` `infoDelivery` messages, handed
   *   to the consumer below and parsed defensively there.
   *
   * What it does **not** buy, so nobody reads more into it than is there: the player is
   * still Google's code talking to Google's servers, it still serves ads, and
   * `-nocookie` reduces rather than removes what it stores on its own origin. The claim is
   * isolation of *our* context, not privacy.
   *
   * ## Why it is sandboxed as well
   *
   * A cross-origin iframe that is not sandboxed may still navigate the top-level browsing
   * context given a user gesture, and the player has affordances that do exactly that (the
   * video title, "Watch on YouTube"). In CEF a top-level navigation reloads the whole
   * instance and drops every bit of phone state — the same failure AGENTS.md §6 bans
   * `window.location` and `window.open` for. `sandbox` withholds `allow-top-navigation`
   * and `allow-popups` by default, so it closes that.
   *
   * `allow-same-origin` is in the list and is safe *because the frame is cross-origin*: it
   * preserves youtube-nocookie.com as the frame's origin rather than granting it ours. The
   * dangerous pairing is `allow-scripts allow-same-origin` on a **same-origin** frame,
   * which can reach out and remove its own sandbox; that is not this.
   *
   * `allow="autoplay"` is the Permissions Policy delegation the official API also performs.
   * A click in this document does not grant user activation to a cross-origin child, so
   * without it the frame is judged on its own activation alone — see the autoplay note in
   * `MusicPlayer.svelte`.
   *
   * ## Why it is invisible rather than absent
   *
   * A `display:none` iframe is a box with no layout, and Chromium has never guaranteed
   * media in one keeps running. The frame is therefore laid out at a real size and made
   * invisible with `opacity-0`, off the bottom-left corner and behind everything. In game
   * the page is a transparent overlay on the world, so an opaque player at any visible
   * size would paint over what the person is looking at.
   *
   * Several of these may now be on screen at once — up to `MAX_AUDIBLE_BROADCASTS` remote
   * ones plus your own — and they are allowed to overlap. Each is still a laid-out box of
   * a real size, which is the property that matters; stacking invisible boxes costs
   * nothing, and spreading them across the viewport would put a 200px void somewhere a
   * future layout has to reason about.
   *
   * ## What a consumer must do, and what it must not
   *
   * `send` is exported for transport commands and is a no-op before the handshake, so a
   * caller does not have to race it. `ready` is bindable, because a consumer that wants to
   * re-send a command on reconnect needs to see the edge rather than be told about it once.
   * `volume` is a prop rather than a command, because every consumer needs it and none of
   * them should have to remember the `0..100` conversion.
   *
   * Nothing here interprets a message. `onmessage` receives the payload **after** the
   * origin and source checks and after JSON parsing, and decides for itself what a state
   * report means — which is exactly the part that differs between your music and somebody
   * else's.
   */
  import { YOUTUBE_EMBED_ORIGIN, YOUTUBE_MESSAGE_ORIGINS, playerCommand } from './state/music';

  interface Props {
    /** The embed URL, already built from validated ids by `embedUrlFor`. */
    url: string;
    /** 0..1. Converted and sent on every change, and once as soon as the frame loads. */
    volume: number;
    /** The frame's accessible name. Distinct per player so a test can address one. */
    title: string;
    /** True once the handshake has been sent. Bindable; false again on a `url` change. */
    ready?: boolean;
    /** An origin-checked, JSON-parsed message from the player. Interpreted by the caller. */
    onmessage?: (payload: { event?: unknown; info?: unknown }) => void;
  }

  let { url, volume, title, ready = $bindable(false), onmessage }: Props = $props();

  let frame = $state<HTMLIFrameElement | undefined>();

  /**
   * Post a command to the player.
   *
   * Exported rather than driven by props because the interesting commands differ per
   * consumer: local playback seeks and skips, a remote broadcast only ever pauses. A call
   * before the frame is ready is silently dropped, which is correct — a fresh frame
   * autoplays from the top of what it was given, so there is nothing a pre-handshake
   * command could achieve that the URL has not already said.
   */
  export function send(message: string): void {
    if (!ready) return;
    // `targetOrigin` is the constant this repo wrote, never `'*'`: a wildcard would post
    // the command to whatever document happens to be in the frame, which after an
    // unexpected navigation is not necessarily YouTube's.
    frame?.contentWindow?.postMessage(message, YOUTUBE_EMBED_ORIGIN);
  }

  const post = (message: string): void => {
    frame?.contentWindow?.postMessage(message, YOUTUBE_EMBED_ORIGIN);
  };

  /**
   * Ask the player to start reporting state, then set the volume before anything is heard.
   *
   * Without the handshake the frame answers nothing; it is the same `listening` message
   * the official API's own bootstrap sends, and `id`/`channel` are the values it uses. The
   * volume follows immediately and not through the effect below, because the effect has
   * already run for this value — a frame that loaded after the last volume change would
   * otherwise start at whatever YouTube's default is, which for a broadcast three streets
   * away is the whole failure.
   */
  const onLoad = () => {
    post(JSON.stringify({ event: 'listening', id: 'gphone-music', channel: 'widget' }));
    post(playerCommand('setVolume', [level(volume)]));
    ready = true;
  };

  const level = (value: number): number =>
    Math.round(Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0)) * 100);

  /**
   * Messages from the player, filtered down to ones this frame could have sent.
   *
   * Origin-checked first and source-checked second, and the second check is what makes
   * several of these safe to have in one page: every frame hears every `message` event, so
   * without `event.source !== frame.contentWindow` your own player's `ended` would be
   * delivered to a neighbour's component and vice versa. The payload past this point is
   * still a cross-origin document's choice and is validated again by whoever reads it.
   */
  const onWindowMessage = (event: MessageEvent) => {
    if (!YOUTUBE_MESSAGE_ORIGINS.includes(event.origin)) return;
    if (!frame || event.source !== frame.contentWindow) return;

    let payload: unknown;
    try {
      payload = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
    } catch {
      return;
    }
    if (typeof payload !== 'object' || payload === null) return;
    onmessage?.(payload);
  };

  $effect(() => {
    window.addEventListener('message', onWindowMessage);
    return () => window.removeEventListener('message', onWindowMessage);
  });

  // A new URL is a new element (see the `{#key}` below), so the handshake starts over and
  // nothing may be posted until it has. Written synchronously here rather than in the
  // element's teardown so a consumer's own effects see the edge in the same tick.
  $effect(() => {
    void url;
    ready = false;
  });

  $effect(() => {
    const next = level(volume);
    if (!ready) return;
    post(playerCommand('setVolume', [next]));
  });
</script>

<!-- Keyed on the URL so a new track gets a fresh element and a fresh `load`, rather than
     a `src` swap whose load event arrives against half-torn-down state. -->
{#key url}
  <!-- `inert`, not `aria-hidden` — the same call `Shell.svelte` makes for a backgrounded
       app, and for a sharper reason here. `aria-hidden` hides the frame from assistive
       tech and does nothing to the tab order: an `<iframe>` is tabbable by default, so
       Tab landed on an invisible 200x200 box with no focus ring, and then on whatever the
       player document has inside it — a keyboard user stranded in a frame they cannot see.
       Measured, not reasoned about: `music.spec.ts` walks a full Tab cycle and fails if
       focus ever reaches this element. axe would call it `aria-hidden-focus` and never
       does, because the sweep is scoped to `[data-testid="phone-frame"]` and this is
       mounted outside it (`a11y.spec.ts`). `inert` covers the nested document too, which
       `tabindex="-1"` on the frame would not. -->
  <div
    class="pointer-events-none fixed bottom-0 left-0 h-[200px] w-[200px] overflow-hidden opacity-0"
    inert
  >
    <iframe
      bind:this={frame}
      {title}
      src={url}
      onload={onLoad}
      class="h-full w-full border-0"
      allow="autoplay; encrypted-media"
      sandbox="allow-scripts allow-same-origin allow-presentation"
      referrerpolicy="strict-origin-when-cross-origin"
    ></iframe>
  </div>
{/key}
