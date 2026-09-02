<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { t } from './messages';
  /**
   * The phone's *own* music. MICA-111 phase 1, and still only that.
   *
   * Mounted by `Shell.svelte` **outside** its `{#if visible}` block, which is the whole
   * reason this is a shell component rather than part of the Music app. Everything inside
   * that block — `ToastHost`, `PhoneFrame`, every resident app — is destroyed when the
   * player lowers the phone. Music is expected to keep playing when the phone is down, so
   * an element inside it would be exactly wrong: the track would stop the moment the phone
   * was put away, which is the one behaviour the ticket rules out.
   *
   * ## What this file is, now that it is not the only player
   *
   * Phase 2 added other people's music, and it is not a variety of this. This file is the
   * consumer that owns a queue, a position, a seek, a repeat mode and an error a person can
   * act on — every one of which is meaningless for a broadcast coming out of somebody
   * else's phone. That one lives in `NearbyMusicFrame.svelte` and holds none of it.
   *
   * The element itself is shared: `MusicFrame.svelte` owns the iframe, the sandbox
   * posture, the handshake, the origin check and the volume conversion, and it carries the
   * reasoning for all of them. What is left here is the conversation between this phone's
   * intent (`state/music.ts`) and one player.
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
   *    it, the attribute in `MusicFrame.svelte` is void and no change here can rescue it.
   *    That is separate from the client's `--autoplay-policy`, which is the gesture
   *    requirement.
   * 5. Whether sound comes out. A player reporting `playing` with a frozen `currentTime`
   *    is an autoplay problem; one whose `currentTime` advances in silence is a codec or
   *    audio-routing problem, and they have different owners.
   *
   * Phase 2 adds a sixth that nothing local can answer: **whether a client stands up four
   * of these at once** — three nearby broadcasts plus your own — without the framerate
   * going. `MAX_AUDIBLE_BROADCASTS` in `sdk/host/seam/music.ts` is the number to lower if
   * it does not, and it is a one-line change on purpose.
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
  import MusicFrame from './MusicFrame.svelte';
  import {
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

  /**
   * The frame's imperative handle — its `send`, and nothing else it happens to have.
   *
   * Typed structurally rather than as the component, so this file depends on the one
   * method it calls instead of on however `svelte2tsx` names an instance type this week.
   */
  let player = $state<{ send: (message: string) => void } | undefined>();
  /** True once the frame has loaded and been told to start reporting. */
  let ready = $state(false);
  /** The last transport command written to the frame, so an unchanged status is not resent. */
  let lastCommand: string | null = null;
  /** The last seek the frame was asked for, so the effect below fires once per request. */
  let lastSeek = 0;

  const origin = typeof window === 'undefined' ? undefined : window.location.origin;

  const url = $derived($musicSource ? embedUrlFor($musicSource, origin) : null);

  /**
   * What a message from the player means to *this* phone's playback.
   *
   * `MusicFrame` has already checked the origin, checked that the message came from its
   * own frame, and parsed the JSON. Everything below this line was still chosen by a
   * cross-origin document, and three things are read out of it and nothing else — a state
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
  const onMessage = (payload: { event?: unknown; info?: unknown }) => {
    const { event: kind, info } = payload;

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
        ? info
        : (info as { playerState?: unknown } | undefined)?.playerState;
    if (typeof raw !== 'number') return;

    // YouTube's player states. -1 unstarted and 5 cued are not news to us.
    if (raw === 0) reportPlayerState('ended');
    else if (raw === 1) reportPlayerState('playing');
    else if (raw === 2) reportPlayerState('paused');
    else if (raw === 3) reportPlayerState('buffering');
  };

  /**
   * Turn the phone's intent into a command.
   *
   * Guarded on the last command written rather than fired on every status read: the effect
   * re-runs whenever `ready` changes too, and re-sending `playVideo` is at best noise and
   * at worst a seek in some player versions.
   */
  $effect(() => {
    const status = $musicStatus;
    if (!ready || !url) return;

    const command = status === 'playing' || status === 'loading' ? 'playVideo' : 'pauseVideo';
    if (command === lastCommand) return;
    lastCommand = command;
    player?.send(playerCommand(command));
  });

  /**
   * Move the playhead where the phone asked.
   *
   * One mechanism for three things that all mean "same track, different position":
   * scrubbing, `repeat: 'one'`, and advancing to a duplicate row. The last two leave the
   * embed URL unchanged — so `MusicFrame` does not rebuild the element and the transport
   * effect above sees no change to send — which is why a token exists at all. Guarded on
   * its last value because this effect also re-runs when `ready` or `url` change.
   *
   * `resume` distinguishes them: a repeat starts playing, a scrub leaves a paused track
   * paused where you put it.
   */
  $effect(() => {
    const request = $musicSeek;
    if (!ready || !url || !request) return;
    if (request.token === lastSeek) return;
    lastSeek = request.token;
    player?.send(playerCommand('seekTo', [request.seconds, true]));
    if (request.resume) player?.send(playerCommand('playVideo'));
  });

  // A source change means a new frame, so the command guard starts over. `lastSeek` catches
  // up to the outstanding request rather than resetting to zero: a fresh frame autoplays
  // from the top already, and replaying a seek issued before it existed would be a second
  // start of the same track.
  $effect(() => {
    void url;
    lastCommand = null;
    lastSeek = get(musicSeek)?.token ?? 0;
  });
</script>

{#if url}
  <!-- `musicOutputVolume`, not `musicVolume`: the setting after ducking. A ringing phone
       turns the music down through this and never through the persisted preference. -->
  <MusicFrame
    bind:this={player}
    bind:ready
    {url}
    volume={$musicOutputVolume}
    title={$t('shell.musicPlayerFrame')}
    onmessage={onMessage}
  />
{/if}
