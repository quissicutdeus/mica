<script lang="ts">
  /**
   * The now-playing card — one component, drawn by the Music app and by the notification
   * shade (MICA-111).
   *
   * ## Why this is shared rather than two cards that resemble each other
   *
   * It was two. The app's card carried artwork, shuffle and repeat; the shade's carried
   * neither, called the same failure by a different word, and had already drifted on which
   * controls it offered. Two cards over one player is two places to fix every bug and two
   * answers to every question about what the player is doing, and the divergence was not a
   * design — nobody decided the shade should have no shuffle, it just never got one.
   *
   * The compact mode is nearly the whole of what survived, and it is spacing: the shade
   * card sits above a scrolling list of notifications, so it spends less height on padding.
   * The one thing it also changes is the failure line — see it below; the advice names the
   * app's own queue controls and is silly beside a card that has no queue under it.
   * Everything else — the wording, the roles, which control appears when, the artwork, the
   * tint — is one implementation, because a person looking at the two should not be able to
   * tell which surface they are on.
   *
   * ## Where it lives
   *
   * `sdk/ui`, exported from `@gphone/sdk/core` rather than `@gphone/sdk`. It is not a
   * primitive an add-on has any business with — it is the transport for the phone's *own*
   * player, which is why Music is a `core: true` app in the first place — and the public
   * SDK is a commitment. `core.ts` is the surface for exactly that: reachable by the shell
   * and by a core app, unreachable from a sandboxed bundle.
   *
   * It takes the stores rather than calling `useMusic()` itself, and that is a seam rather
   * than ceremony: `sdk/ui` may not import `shell/` (`seam.test.ts`), and a hook called in
   * here would resolve its permission against whichever app happened to be rendering. The
   * app passes `useMusic()`; the shell passes the same stores out of `shell/state/music`.
   *
   * ## The tint
   *
   * A card is tinted from its album art: the dominant colour of the artwork
   * (`lib/dominantColor.ts`) is used as an M3 **seed**, `buildSchemes` turns that into a
   * whole role set, and the block of `--color-*` custom properties it produces is written
   * onto this element — where it shadows the phone's own theme for this subtree and
   * nothing else. So every class below is the same role name it would otherwise have been,
   * and the card comes out warm over a red cover and cool over a blue one without a single
   * colour being chosen here.
   *
   * That indirection is what keeps it legible. M3 builds an `on-` role to contrast with
   * its surface, so a black cover and a white one both produce a readable card; picking a
   * colour off the image and painting with it would put this component in the business of
   * guaranteeing contrast, which it cannot do.
   *
   * **Every failure lands on the untinted card**, which is the card as it was before any of
   * this: no artwork, blocked host, refused CORS, tainted canvas, a cover with no colour
   * worth the name. `dominantColorFrom` resolves `null` for all of them and never rejects.
   * That matters more in CEF than in a browser — whether `img.youtube.com` is reachable
   * from a `cfx-nui-` origin at all is an open in-game question, and whether it sends CORS
   * headers there is a further unknown on top (`docs/testing-music-in-cef.md`).
   */
  import type { Readable } from 'svelte/store';
  import type {
    MusicError,
    MusicNowPlaying,
    MusicPosition,
    MusicRepeat,
    MusicSource,
    MusicStatus
  } from '../host/inProcess/facets/music';
  import { thumbnailUrlFor } from '@shared/youtube';
  import { describeMusicError } from '../../lib/musicErrors';
  import { formatDuration } from '../../lib/formatters';
  import { buildSchemes, cssVarBlock } from '../../lib/m3';
  import { dominantColorFrom } from '../../lib/dominantColor';
  import Button from './Button.svelte';
  import MusicNoteIcon from './icons/MusicNoteIcon.svelte';
  import PauseIcon from './icons/PauseIcon.svelte';
  import PlayIcon from './icons/PlayIcon.svelte';
  import RepeatIcon from './icons/RepeatIcon.svelte';
  import RepeatOneIcon from './icons/RepeatOneIcon.svelte';
  import ShuffleIcon from './icons/ShuffleIcon.svelte';
  import SkipNextIcon from './icons/SkipNextIcon.svelte';
  import SkipPreviousIcon from './icons/SkipPreviousIcon.svelte';
  import StopIcon from './icons/StopIcon.svelte';
  import UsersIcon from './icons/UsersIcon.svelte';

  /**
   * What the card needs from the player, and nothing else.
   *
   * Structural on purpose: `useMusic()` satisfies it with room to spare, and the shell
   * satisfies it with an object literal built out of `shell/state/music`. Neither side has
   * to name a type, and a store this card starts reading is a compile error at both call
   * sites rather than an empty space on one of them.
   */
  interface MusicCardStores {
    musicSource: Readable<MusicSource | null>;
    musicStatus: Readable<MusicStatus>;
    musicNowPlaying: Readable<MusicNowPlaying | null>;
    musicError: Readable<MusicError | null>;
    musicPosition: Readable<MusicPosition>;
    musicRepeat: Readable<MusicRepeat>;
    musicShuffle: Readable<boolean>;
    musicHasNext: Readable<boolean>;
    musicHasPrevious: Readable<boolean>;
    seekMusic: (to: number) => void;
    cycleRepeat: () => void;
    toggleShuffle: () => void;
    nextTrack: () => void;
    previousTrack: () => void;
    pauseMusic: () => void;
    resumeMusic: () => void;
    stopMusic: () => void;
  }

  interface Props {
    music: MusicCardStores;
    /** Which of the two generated schemes the phone is showing, so the tint matches it. */
    mode?: 'light' | 'dark';
    /** Tighter padding, for the shade, where the card sits above the notification list. */
    compact?: boolean;
    /**
     * Makes the name a button. The shade passes one — the card is the only route to the
     * app from behind a closed phone — and the app itself does not, because you are
     * already there.
     */
    onopen?: () => void;
  }

  let { music, mode = 'dark', compact = false, onopen }: Props = $props();

  // The bundle is destructured once, and that is not the reactivity bug the compiler takes
  // it for: what changes is the *contents* of these stores, not which object the prop
  // points at. Both call sites build it once and never swap it — the shell as a module-scope
  // literal, the app as `useMusic()` — and a card handed a different player mid-life would
  // be a different card.
  // svelte-ignore state_referenced_locally
  const {
    musicSource,
    musicStatus,
    musicNowPlaying,
    musicError,
    musicPosition,
    musicRepeat,
    musicShuffle,
    musicHasNext,
    musicHasPrevious,
    seekMusic,
    cycleRepeat,
    toggleShuffle,
    nextTrack,
    previousTrack,
    pauseMusic,
    resumeMusic,
    stopMusic
  } = music;

  /**
   * `loading` counts as playing: the phone has been asked to play, and the button that
   * undoes that is Pause rather than a second Play.
   */
  const isPlaying = $derived($musicStatus === 'playing' || $musicStatus === 'loading');

  /**
   * A status word, and a short one. The sentence explaining a refusal is the line below
   * (`describeMusicError`); what this has to achieve is that a track the player has
   * refused never reads as "Playing".
   */
  const statusLabel = $derived(
    $musicStatus === 'error'
      ? "Can't play"
      : $musicStatus === 'loading'
        ? 'Starting…'
        : $musicStatus === 'playing'
          ? 'Playing'
          : $musicStatus === 'paused'
            ? 'Paused'
            : 'Stopped'
  );

  /**
   * What to call the track.
   *
   * The reported title when the embed has given one, the id when it has not — never a
   * fetch of our own to find a nicer name. The id is the only thing the phone actually
   * stores (`shared/youtube.ts`) and it is what a person would paste back to reach the
   * same track, so it is an honest fallback rather than a placeholder. In CEF the title
   * channel may never answer at all.
   */
  const trackLabel = $derived.by(() => {
    const reported = $musicNowPlaying?.title;
    if (reported) return reported;
    const source = $musicSource;
    if (!source) return '';
    if (source.videoId) return source.videoId;
    return `Playlist ${source.playlistId ?? ''}`.trim();
  });

  /** A title is prose; an id is not, and reads back more easily in a monospace face. */
  const labelIsTitle = $derived(Boolean($musicNowPlaying?.title));

  /**
   * The line under the name, which mostly is not there.
   *
   * A playlist keeps one, because `PL…` is genuinely what is loaded — the embed advances
   * inside it and the phone does not choose what plays next, so saying where it has got to
   * is the difference between a queue a person can follow and one that looks stuck. A
   * video id is never repeated here: `trackLabel` already falls back to it.
   */
  const nowSub = $derived.by(() => {
    const source = $musicSource;
    if (!source?.playlistId) return null;
    const info = $musicNowPlaying;
    if (info && info.playlistIndex !== null && info.playlistCount !== null) {
      return `Playlist · ${info.playlistIndex + 1} of ${info.playlistCount}`;
    }
    return `Playlist ${source.playlistId}`;
  });

  /**
   * The id, for the one case that still wants it: a track that played long enough to be
   * named and *then* refused. The name above is a title, so the id has nowhere else to
   * appear — and that is exactly when somebody wants it, to paste into a bug report or
   * back into the field to check the link themselves.
   */
  const hiddenId = $derived($musicError && labelIsTitle ? ($musicSource?.videoId ?? null) : null);

  /**
   * Whether to say, here, that other people can hear this.
   *
   * Broadcasting is on by default (phase 2) — pressing Play makes you audible to the
   * street, with no toggle — so a surface that shows music playing has to say so. Only
   * while sound is actually coming out: a paused or refused track is not being broadcast,
   * and claiming otherwise is the kind of warning people learn to ignore.
   */
  const outLoud = $derived($musicStatus === 'playing' || $musicStatus === 'loading');

  /**
   * The scrubber's own value while a finger is down on it. `null` when nobody is dragging,
   * so the control follows the player — without it, every position report during a drag
   * yanks the handle out from under the person.
   */
  let scrub = $state<number | null>(null);
  const scrubAt = $derived(scrub ?? $musicPosition.current);

  /**
   * No duration, no scrubber — which is not the same as a zero-length track. The player
   * reports `0` until it knows, and forever for a live stream, and a slider that cannot
   * move is a lie about what is playing.
   */
  const seekable = $derived($musicPosition.duration > 0 && $musicStatus !== 'error');

  const repeatLabel = $derived(
    $musicRepeat === 'off'
      ? 'Repeat off'
      : $musicRepeat === 'all'
        ? 'Repeat queue'
        : 'Repeat one track'
  );

  /**
   * The artwork, from whichever id is more specific: what the player says it is playing,
   * or failing that what is loaded. A playlist row has neither until the embed reports a
   * video, which is why the tile has a placeholder rather than an empty `<img>` — a
   * `src=""` is not a blank image, Chromium resolves it against the document and
   * re-requests the page.
   */
  const art = $derived(thumbnailUrlFor($musicNowPlaying?.videoId ?? $musicSource?.videoId ?? null));

  /** The seed extracted from `art`, or `null` for every failure path. See the file note. */
  let tintSeed = $state<string | null>(null);

  $effect(() => {
    const url = art;
    tintSeed = null;
    if (!url) return;

    let live = true;
    void dominantColorFrom(url)
      .then((seed) => {
        // The artwork can change while this is outstanding — a queue moved on, or the
        // shade was pulled twice. Without the guard the slower of two answers wins.
        if (live) tintSeed = seed;
      })
      // `dominantColorFrom` resolves `null` for every failure it knows about and is
      // documented never to reject. This is the belt to that braces: an unhandled
      // rejection out of an `$effect` is a console error in game for a decoration.
      .catch(() => {});
    return () => {
      live = false;
    };
  });

  /**
   * The tint as a block of `--color-*` custom properties, or `''`.
   *
   * An inline `style` rather than a class, because the value is computed per track and
   * there is no class to write for a colour nobody knew in advance. Every value in it is a
   * literal `rgb()`/`rgba()` — `lib/m3.ts` composites the state layers numerically rather
   * than deferring to `color-mix()`, which is Chromium 111 and past the CEF floor.
   */
  const tintStyle = $derived(tintSeed ? cssVarBlock(buildSchemes(tintSeed)[mode]) : '');
</script>

<!-- The card. `bg-surface-container-low` is a role, so under a tint it is the album's own
     dark surface rather than the phone's, and untinted it is exactly the card this
     replaced. -->
<div
  class="bg-surface-container-low rounded-lg {compact ? 'p-2' : 'p-3'}"
  style={tintStyle}
  data-testid="now-playing-card"
>
  {#snippet identity()}
    <!-- The artwork tile always occupies its space, even with nothing to draw: a tile that
         appears and disappears with the embed's reporting would move every line beside it.
         `alt=""` because the name is right there — the picture is decoration.

         **No `crossorigin` here, deliberately.** The tint's own request sets it (and must:
         without it the canvas is tainted and `getImageData` throws). Setting it on the
         *displayed* image would mean a host that declines CORS renders no picture at all,
         which trades a missing tint for a missing cover. -->
    {#if art}
      <img
        src={art}
        alt=""
        class="bg-surface-container-high h-10 w-16 shrink-0 rounded-md object-cover"
      />
    {:else}
      <span
        class="bg-surface-container-high text-on-surface-variant flex h-10 w-16 shrink-0 items-center justify-center rounded-md"
      >
        <MusicNoteIcon class="size-icon-sm" />
      </span>
    {/if}

    <span class="min-w-0 flex-1">
      <span class="text-body-small flex items-center gap-1">
        <!-- The accent is on the word itself rather than on the row around it: the status
             word is the one thing here worth finding at a glance, and a refused track must
             not arrive in the same colour as a playing one. -->
        <span class="truncate {$musicError ? 'text-error' : 'text-on-surface-variant'}"
          >{statusLabel}</span
        >
        {#if outLoud}
          <!-- The disclosure sits beside the status word rather than only in the standing
               line at the bottom of the Music screen, which is off-screen the moment the
               queue is a few rows long — exactly when somebody has been playing for a while
               and is least likely to remember that a street can hear them. -->
          <span class="text-label-small text-on-surface-variant flex shrink-0 items-center gap-1">
            <UsersIcon class="size-icon-sm" />
            Out loud
          </span>
        {/if}
      </span>

      <!-- `font-mono` only while this is an id rather than a reported title: an id reads as
           a code and a title does not. Truncated either way — a YouTube title outruns this
           row far more often than it fits it. -->
      <span class="text-body-medium text-on-surface block truncate" class:font-mono={!labelIsTitle}
        >{trackLabel || 'Nothing loaded'}</span
      >

      {#if $musicError}
        <!-- The reason, and — only where there is a queue on screen to act on — what to do
             about it. "Skip or remove it" names the Music app's own controls, so appending
             it in the shade would be advice about buttons the person cannot see.

             Not truncated in the app: it is the one line on that screen explaining why
             nothing is happening, and half of it leaves somebody guessing. Truncated in
             the shade, where the row is one item in a list and the app is one tap away. -->
        <span class="text-label-small text-error block" class:truncate={compact}
          >{describeMusicError($musicError.reason)}{compact ? '' : ' · skip or remove it'}</span
        >
        {#if hiddenId}
          <span class="text-label-small text-on-surface-variant block truncate font-mono"
            >{hiddenId}</span
          >
        {/if}
      {:else if nowSub}
        <span class="text-label-small text-on-surface-variant block truncate">{nowSub}</span>
      {/if}
    </span>
  {/snippet}

  {#if onopen}
    <button
      type="button"
      class="hover:bg-surface-container duration-short ease-standard flex w-full min-w-0 items-center gap-3 rounded-lg text-left transition-colors"
      onclick={onopen}
      title="Open Music"
    >
      {@render identity()}
    </button>
  {:else}
    <div class="flex items-center gap-3">
      {@render identity()}
    </div>
  {/if}

  <!-- The scrubber, full width and on its own row. The screen is 400px and this card
       already carries artwork, three lines and six buttons; a scrubber squeezed in beside
       them would be a few dozen pixels of drag distance across a four-minute song, which is
       worse than not offering one.

       A native `input[type=range]`, so it is operable from the keyboard with no work of
       ours — arrows step it, Home and End jump — which a div-and-pointer scrubber would not
       be and axe would not catch. -->
  {#if seekable}
    <div class={compact ? 'mt-2' : 'mt-3'}>
      <input
        type="range"
        min="0"
        max={$musicPosition.duration}
        value={scrubAt}
        aria-label="Seek"
        aria-valuetext={formatDuration(scrubAt)}
        oninput={(e) => (scrub = Number(e.currentTarget.value))}
        onchange={(e) => {
          seekMusic(Number(e.currentTarget.value));
          scrub = null;
        }}
        class="bg-surface-container-high accent-primary h-1 w-full cursor-pointer appearance-none rounded-lg"
      />
      <div class="text-label-small text-on-surface-variant mt-1 flex justify-between">
        <span>{formatDuration(scrubAt)}</span>
        <span>{formatDuration($musicPosition.duration)}</span>
      </div>
    </div>
  {/if}

  <!-- Transport: the two queue *modes* on the left, the five things you can do to the
       playhead on the right.

       Each of the three that can be inert is absent rather than disabled — play/pause on a
       refused track, previous and next with nowhere to go. A disabled button costs the same
       space as a working one and teaches nothing, and `musicHasNext` is `pickNext()` itself
       rather than a second opinion about it, so the control cannot be offered while
       pressing it would do nothing. Stop always works, including on a refused track, which
       is why it is the one that never goes away. -->
  <div class="flex items-center justify-between {compact ? 'mt-2' : 'mt-3'}">
    <div class="flex items-center gap-1">
      <Button
        onclick={toggleShuffle}
        variant="icon"
        aria-pressed={$musicShuffle}
        aria-label="Shuffle"
        class={$musicShuffle ? 'text-on-primary-container bg-primary-container' : ''}
      >
        <ShuffleIcon class="h-5 w-5" />
      </Button>
      <Button
        onclick={cycleRepeat}
        variant="icon"
        aria-label={repeatLabel}
        class={$musicRepeat === 'off' ? '' : 'text-on-primary-container bg-primary-container'}
      >
        {#if $musicRepeat === 'one'}
          <RepeatOneIcon class="h-5 w-5" />
        {:else}
          <RepeatIcon class="h-5 w-5" />
        {/if}
      </Button>
    </div>

    <div class="flex items-center gap-1">
      {#if $musicHasPrevious}
        <Button onclick={previousTrack} variant="icon" aria-label="Previous track">
          <SkipPreviousIcon class="h-5 w-5" />
        </Button>
      {/if}

      {#if $musicStatus !== 'error'}
        <Button
          onclick={() => (isPlaying ? pauseMusic() : resumeMusic())}
          variant="icon"
          class="bg-primary-container text-on-primary-container"
          aria-label={isPlaying ? 'Pause' : 'Play'}
        >
          {#if isPlaying}
            <PauseIcon class="h-5 w-5" />
          {:else}
            <PlayIcon class="h-5 w-5" />
          {/if}
        </Button>
      {/if}

      {#if $musicHasNext}
        <Button onclick={nextTrack} variant="icon" aria-label="Next track">
          <SkipNextIcon class="h-5 w-5" />
        </Button>
      {/if}

      <!-- "Stop music", and it means exactly that: the audio stops and the queue is left
           alone. `clearQueue` is the Music app's own button, below the queue it empties. -->
      <Button onclick={stopMusic} variant="icon" aria-label="Stop music">
        <StopIcon class="h-5 w-5" />
      </Button>
    </div>
  </div>
</div>
