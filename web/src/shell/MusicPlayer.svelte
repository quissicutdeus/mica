<script lang="ts">
  /**
   * The thing that actually makes noise. MICA-111 phase 1.
   *
   * Mounted by `Shell.svelte` **outside** its `{#if visible}` block, which is the whole
   * reason this is a shell component rather than part of the Music app. Everything inside
   * that block — `ToastHost`, `PhoneFrame`, every resident app — is destroyed when the
   * player lowers the phone. Music is expected to keep playing when the phone is down, so
   * an element inside it would be exactly wrong: the track would stop the moment the phone
   * was put away, which is the one behaviour the ticket rules out.
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
   * - No typed events. State comes back as `onStateChange` `infoDelivery` messages, parsed
   *   defensively below, and treated as advisory (`reportPlayerState` in `state/music.ts`).
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
   * without it the frame is judged on its own activation alone — see the autoplay note at
   * the bottom of this comment.
   *
   * ## Why it is invisible rather than absent
   *
   * A `display:none` iframe is a box with no layout, and Chromium has never guaranteed
   * media in one keeps running. The frame is therefore laid out at a real size and made
   * invisible with `opacity-0`, off the bottom-left corner and behind everything. In game
   * the page is a transparent overlay on the world, so an opaque player at any visible
   * size would paint over what the person is looking at.
   *
   * ## What is unproven, and only a game can prove it
   *
   * Playwright drives a modern Chromium with a normal network stack; none of the three
   * things below is answerable outside FiveM.
   * 1. Whether CEF loads the embed at all — the shell page's CSP is not ours to inspect,
   *    and the client may refuse the request outright.
   * 2. Whether autoplay is permitted. `allow="autoplay"` delegates the policy, but
   *    Chromium still weighs the top frame's own activation, and CEF's
   *    `--autoplay-policy` is set by the client, not by us.
   * 3. Whether the `postMessage` channel is answered — the `origin` parameter on the embed
   *    URL is what the player validates commands against, and `https://cfx-nui-gphone` is
   *    not an origin YouTube has ever been asked about.
   *
   * If it half-works in game, the two things to try in order are dropping `sandbox`, then
   * dropping the `origin` parameter (`embedUrlFor` in `state/music.ts`).
   */
  import {
    YOUTUBE_MESSAGE_ORIGINS,
    YOUTUBE_EMBED_ORIGIN,
    embedUrlFor,
    musicSource,
    musicStatus,
    musicVolume,
    playerCommand,
    reportPlayerState
  } from './state/music';

  let frame = $state<HTMLIFrameElement | undefined>();
  /** True once the frame has loaded and been told to start reporting. */
  let ready = $state(false);
  /** The last transport command written to the frame, so an unchanged status is not resent. */
  let lastCommand: string | null = null;

  const origin = typeof window === 'undefined' ? undefined : window.location.origin;

  const url = $derived($musicSource ? embedUrlFor($musicSource, origin) : null);

  const send = (message: string) => {
    // `targetOrigin` is the constant this repo wrote, never `'*'`: a wildcard would post
    // the command to whatever document happens to be in the frame, which after an
    // unexpected navigation is not necessarily YouTube's.
    frame?.contentWindow?.postMessage(message, YOUTUBE_EMBED_ORIGIN);
  };

  /**
   * Ask the player to start reporting state.
   *
   * Without this handshake the frame answers nothing; it is the same `listening` message
   * the official API's own bootstrap sends, and `id`/`channel` are the values it uses.
   */
  const startListening = () => {
    send(JSON.stringify({ event: 'listening', id: 'gphone-music', channel: 'widget' }));
  };

  const onLoad = () => {
    ready = true;
    lastCommand = null;
    startListening();
    send(playerCommand('setVolume', [Math.round($musicVolume * 100)]));
  };

  /**
   * Messages from the player.
   *
   * Origin-checked first and shape-checked second: everything below this line is a string
   * a cross-origin document chose, so it is parsed into a state name and nothing else. No
   * field of it reaches the DOM, and `reportPlayerState` accepts only the four names.
   */
  const onMessage = (event: MessageEvent) => {
    if (!YOUTUBE_MESSAGE_ORIGINS.includes(event.origin)) return;
    if (!frame || event.source !== frame.contentWindow) return;

    let payload: unknown;
    try {
      payload = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
    } catch {
      return;
    }
    if (typeof payload !== 'object' || payload === null) return;

    const { event: kind, info } = payload as { event?: unknown; info?: unknown };
    if (kind !== 'infoDelivery' && kind !== 'onStateChange') return;

    // `onStateChange` carries the code directly; `infoDelivery` wraps it in `info`.
    const raw =
      kind === 'onStateChange'
        ? (payload as { info?: unknown }).info
        : (info as { playerState?: unknown } | undefined)?.playerState;
    if (typeof raw !== 'number') return;

    // YouTube's player states. -1 unstarted and 5 cued are not news to us.
    if (raw === 0) reportPlayerState('ended');
    else if (raw === 1) reportPlayerState('playing');
    else if (raw === 2) reportPlayerState('paused');
    else if (raw === 3) reportPlayerState('buffering');
  };

  $effect(() => {
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  });

  /**
   * Turn the phone's intent into a command.
   *
   * Guarded on the last command written rather than fired on every status read: the effect
   * also re-runs when the volume changes, and re-sending `playVideo` on a volume nudge is
   * at best noise and at worst a seek in some player versions.
   */
  $effect(() => {
    const status = $musicStatus;
    if (!ready || !url) return;

    const command = status === 'playing' || status === 'loading' ? 'playVideo' : 'pauseVideo';
    if (command === lastCommand) return;
    lastCommand = command;
    send(playerCommand(command));
  });

  $effect(() => {
    const volume = Math.round($musicVolume * 100);
    if (!ready || !url) return;
    send(playerCommand('setVolume', [volume]));
  });

  // A source change means a new frame (see the `{#key}` below), so the handshake and the
  // command guard both start over.
  $effect(() => {
    void url;
    ready = false;
    lastCommand = null;
  });
</script>

{#if url}
  <!-- Keyed on the URL so a new track gets a fresh element and a fresh `load`, rather than
       a `src` swap whose load event arrives against half-torn-down state. -->
  {#key url}
    <div
      class="pointer-events-none fixed bottom-0 left-0 h-[200px] w-[200px] overflow-hidden opacity-0"
      aria-hidden="true"
    >
      <iframe
        bind:this={frame}
        title="gPhone music player"
        src={url}
        onload={onLoad}
        class="h-full w-full border-0"
        allow="autoplay; encrypted-media"
        sandbox="allow-scripts allow-same-origin allow-presentation"
        referrerpolicy="strict-origin-when-cross-origin"
      ></iframe>
    </div>
  {/key}
{/if}
