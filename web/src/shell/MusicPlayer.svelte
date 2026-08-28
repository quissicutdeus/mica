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
   * Playwright drives a modern Chromium with a normal network stack, so none of the five
   * below is answerable outside FiveM. **The exact console lines that settle each one are
   * in `docs/testing-music-in-cef.md`**; this is the list, not the procedure.
   *
   * Worth saying first, because it changes what the list is for: nothing in the Chromium
   * 103 baseline forbids any of this. Sandboxed iframes, the `allow` attribute and its JS
   * API, `postMessage`, MSE and WebM are all supported far below the floor
   * (`docs/cef-baseline.md`). Every risk here is a property of the FiveM *client* — what
   * it lets this page load, what it delegates to it, how it launched CEF — so the pending
   * CEF upgrade is not a plan for any of them.
   *
   * 1. Whether CEF loads the embed at all. The client may refuse the navigation, and the
   *    answer only means something if you also try a frame at some other third-party
   *    origin: "YouTube is refused" and "any external document is refused" are different
   *    findings with different fallbacks.
   * 2. Whether the `postMessage` channel is answered. The `origin` parameter on the embed
   *    URL is what the player validates commands against, and `https://cfx-nui-gphone` is
   *    not an origin YouTube has ever been asked about.
   * 3. Whether it talks *back*, which is not the same as accepting a command. The title
   *    the queue draws comes from `videoData` in the same `infoDelivery` payload parsed
   *    below, and nothing else can supply one — so the embed can play audibly while every
   *    row stays labelled with its id.
   * 4. Whether autoplay is permitted, which is *two* questions and not one. `allow` can
   *    only delegate a feature this document already has, and `autoplay`'s default
   *    allowlist is `self` — so if FiveM's root frame embeds the phone without delegating
   *    it, the attribute below is void and no change here can rescue it. That is separate
   *    from the client's `--autoplay-policy`, which is the gesture requirement.
   * 5. Whether sound comes out. A player reporting `playing` with a frozen `currentTime`
   *    is an autoplay problem; one whose `currentTime` advances in silence is a codec or
   *    audio-routing problem, and they have different owners.
   *
   * If it half-works, change one attribute at a time and let the failure pick which: a URL
   * parameter cannot stop a document loading, so a frame that never loads can only be
   * `sandbox`, while a frame that loads and goes silent is the `origin` parameter
   * (`embedUrlFor` in `state/music.ts`). A player that works only with `sandbox` removed is
   * a security regression to decide on rather than a fix to commit.
   *
   * Not this file's, but part of the same in-game session: the queue's artwork is a second
   * origin (`img.youtube.com`, via `thumbnailUrlFor`), fetched as an image rather than a
   * document. It can fail while this frame works, and it fails looking like a queue bug.
   *
   * One thing that is *not* on the list, because it would look like a lead and is not:
   * `shell/state/audio.ts`'s eager warm/unlock does not transfer here. That context is in
   * this document; the embed's audio is in another origin's, and user activation does not
   * cross into a cross-origin child.
   */
  import { get } from 'svelte/store';
  import {
    YOUTUBE_MESSAGE_ORIGINS,
    YOUTUBE_EMBED_ORIGIN,
    embedUrlFor,
    musicOutputVolume,
    musicSeek,
    musicSource,
    musicStatus,
    playerCommand,
    reportNowPlaying,
    reportPlayerError,
    reportPlayerProgress,
    reportPlayerState
  } from './state/music';

  let frame = $state<HTMLIFrameElement | undefined>();
  /** True once the frame has loaded and been told to start reporting. */
  let ready = $state(false);
  /** The last transport command written to the frame, so an unchanged status is not resent. */
  let lastCommand: string | null = null;
  /** The last seek the frame was asked for, so the effect below fires once per request. */
  let lastSeek = 0;

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
    send(playerCommand('setVolume', [Math.round($musicOutputVolume * 100)]));
  };

  /**
   * Messages from the player.
   *
   * Origin-checked first and shape-checked second: everything below this line was chosen
   * by a cross-origin document. Three things are read out of it and nothing else — a state
   * name from a fixed set of four, the identity of what is playing, and an error code.
   *
   * The identity is where the app's titles and thumbnails come from, and it is why the
   * phone makes no network call to name a track (MICA-111 phase 3): the same message the
   * player was already sending for playback state carries `videoData.title`, the id it is
   * actually on, and a playlist's length and position. `reportNowPlaying` re-validates
   * every field and bounds the title; none of it reaches the DOM as markup.
   *
   * The error frames are the same bargain and they matter more than they look. Without
   * them a video whose uploader disabled embedding — a large fraction of the music on
   * YouTube — leaves the phone on `Starting…` with no way to know it never will start, and
   * that hang is *indistinguishable from CEF refusing the frame*, which is the one thing
   * the in-game procedure exists to test. See `reportPlayerError` in `state/music.ts`.
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

    // `onError` carries the code the way `onStateChange` carries the state: bare in
    // `info`. `infoDelivery` reports the same failure as an `errorCode` inside its blob,
    // and both are honoured because which one arrives is the player's choice, not ours —
    // the second report is a no-op, since the phone is already in the error state by then.
    if (kind === 'onError') {
      reportPlayerError(info);
      return;
    }
    if (kind !== 'infoDelivery' && kind !== 'onStateChange') return;
    if (kind === 'infoDelivery' && typeof info === 'object' && info !== null) {
      const { errorCode } = info as { errorCode?: unknown };
      if (typeof errorCode === 'number') reportPlayerError(errorCode);
    }

    // `onStateChange` carries the code directly; `infoDelivery` wraps it in `info` and is
    // the only one of the two that says anything about *what* is playing.
    if (kind === 'infoDelivery' && typeof info === 'object' && info !== null) {
      const { videoData, playlist, playlistIndex } = info as {
        videoData?: unknown;
        playlist?: unknown;
        playlistIndex?: unknown;
      };
      const data = (typeof videoData === 'object' && videoData !== null ? videoData : {}) as {
        title?: unknown;
        video_id?: unknown;
      };
      reportNowPlaying({
        title: data.title,
        videoId: data.video_id,
        playlistIndex,
        playlistCount: Array.isArray(playlist) ? playlist.length : undefined
      });
      // Position rides the same push. There is no way to ask for it — see
      // `reportPlayerProgress` for why a poll would be silent rather than expensive.
      reportPlayerProgress(info);
    }

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

  // `musicOutputVolume`, not `musicVolume`: the setting after ducking. A ringing phone
  // turns the music down through this and never through the persisted preference.
  $effect(() => {
    const volume = Math.round($musicOutputVolume * 100);
    if (!ready || !url) return;
    send(playerCommand('setVolume', [volume]));
  });

  /**
   * Move the playhead where the phone asked.
   *
   * One mechanism for three things that all mean "same track, different position":
   * scrubbing, `repeat: 'one'`, and advancing to a duplicate row. The last two leave the
   * embed URL unchanged — so the `{#key url}` below does not rebuild the frame and the
   * transport effect above sees no change to send — which is why a token exists at all.
   * Guarded on its last value because this effect also re-runs when `ready` or `url`
   * change.
   *
   * `resume` distinguishes them: a repeat starts playing, a scrub leaves a paused track
   * paused where you put it.
   */
  $effect(() => {
    const request = $musicSeek;
    if (!ready || !url || !request) return;
    if (request.token === lastSeek) return;
    lastSeek = request.token;
    send(playerCommand('seekTo', [request.seconds, true]));
    if (request.resume) send(playerCommand('playVideo'));
  });

  // A source change means a new frame (see the `{#key}` below), so the handshake and the
  // command guard both start over. `lastSeek` catches up to the outstanding request rather
  // than resetting to zero: a fresh frame autoplays from the top already, and replaying a
  // seek issued before it existed would be a second start of the same track.
  $effect(() => {
    void url;
    ready = false;
    lastCommand = null;
    lastSeek = get(musicSeek)?.token ?? 0;
  });
</script>

{#if url}
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
