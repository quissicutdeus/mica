<script lang="ts">
  /**
   * The one control for playing music that does not require opening the Music app.
   * MICA-111 phase 4, shell half.
   *
   * ## The bug this exists for
   *
   * Phase 1 put the player outside `Shell.svelte`'s `{#if visible}` block on purpose, so a
   * track survives the phone being put away (`state/music.ts`). That is the feature — and
   * it shipped with the other half missing: the only stop button was inside the app, so a
   * person who started a track, closed the phone and then wanted silence had to reopen the
   * phone, find Music, and find the button. Something that keeps making noise after you
   * put the device down needs an off switch on the surface you reach first.
   *
   * ## Why the shade, and why above the list
   *
   * The shade is already the "things happening now" surface and it is one pull from any
   * screen, app or home. Within it this sits **below the quick-settings tiles and above
   * the notification list**, for two reasons:
   *
   * - The list is a scroller of unbounded length. Below it, the control would be
   *   off-screen exactly when a lot is going on, which is the one place a
   *   reach-it-without-the-app control may not be.
   * - The tiles above are the phone's own hardware switches — network, bluetooth,
   *   airplane, DND, flashlight. Music transport is that category, not the notification
   *   category, and sitting with them says so before anybody reads a word.
   *
   * ## It is not a notification, and is not dismissible
   *
   * Nothing here goes through `state/notificationPolicy.ts`. It is drawn straight from
   * `state/music.ts`, so Do Not Disturb — which is a statement about *interruptions*, and
   * has nothing to say about a control the player went looking for — cannot hide it, and
   * neither can a per-app mute on `music`. It is likewise outside `shadeNotifications`,
   * so Clear All does not touch it, `SwipeableRow` is not wrapped around it, and there is
   * no dismiss affordance: dismissing the control while the track kept playing would be
   * the original bug again in a different shape.
   *
   * The row disappears exactly when the music does. Stop is what removes it.
   *
   * ## What Stop means here, deliberately
   *
   * `stopMusic` silences and unloads the player; **the queue survives it**, and
   * `clearQueue` is the one that discards. This control uses the first and never the
   * second, and that asymmetry with the Music app is the point rather than an oversight.
   *
   * The shade is the low-deliberation surface: it is one pull from any screen and it is
   * where somebody reaches mid-conversation to kill the noise. Everything that happens
   * there should be recoverable, and this is — press play in the app and the queue is
   * where it was. Discarding eight queued tracks from a one-tap control with no
   * confirmation and no undo is not, and the app already has a screen's worth of room to
   * ask that question properly. `stops the audio and keeps the queue` below is the test
   * that says so, because "stop should obviously also clear" is a plausible-sounding
   * change somebody will make later.
   */
  import { musicNowPlaying, musicSource, musicStatus } from './state/music';
  import { pauseMusic, resumeMusic, stopMusic } from './state/music';
  import { openApp } from './state/navigation';
  import { closeShade } from './state/shade';
  import MusicNoteIcon from '../sdk/ui/icons/MusicNoteIcon.svelte';
  import PauseIcon from '../sdk/ui/icons/PauseIcon.svelte';
  import PlayIcon from '../sdk/ui/icons/PlayIcon.svelte';
  import StopIcon from '../sdk/ui/icons/StopIcon.svelte';

  /**
   * `loading` counts as playing here, matching the app's own transport: the phone has
   * been asked to play and the button that would undo that is Pause, not another Play.
   */
  const isPlaying = $derived($musicStatus === 'playing' || $musicStatus === 'loading');

  /**
   * A status word, not a reason. The reason for a failure is a sentence and this row has
   * one short line for a state — the Music app has the screen to say which refusal it was
   * (`describeMusicError`, one wording, in `lib/musicErrors.ts`). What matters here is
   * that a track the player has refused never reads as "Playing".
   */
  const statusLabel = $derived(
    $musicStatus === 'error'
      ? "Can't play"
      : $musicStatus === 'loading'
        ? 'Starting…'
        : $musicStatus === 'paused'
          ? 'Paused'
          : 'Playing'
  );

  /**
   * What to call the track, in the one line this row has for it.
   *
   * The reported title when the embed has given one, and the id when it has not — never a
   * fetch of our own to find a nicer name. The id is the only thing the phone actually
   * stores (`shared/youtube.ts`), and it is what a person would paste back to reach the
   * same track, so it is an honest fallback rather than a placeholder.
   *
   * Held here rather than in `state/music.ts` because it is this row's wording. The Music
   * app has a screen to spend on the same question and answers it at more length.
   */
  const trackLabel = $derived.by(() => {
    const reported = $musicNowPlaying?.title;
    if (reported) return reported;
    const source = $musicSource;
    if (!source) return '';
    if (source.videoId) return source.videoId;
    return `Playlist ${source.playlistId ?? ''}`.trim();
  });

  /** A title is prose; an id is not, and is easier to read back in a monospace face. */
  const labelIsTitle = $derived(Boolean($musicNowPlaying?.title));

  /**
   * The accent this row is drawn in, and the reason it is not a constant.
   *
   * The status *word* tells the truth about a refused track; the colour has to as well, or
   * "CAN'T PLAY" arrives in the same accent as "PLAYING" and the row still reads, at a
   * glance, as working. `text-error` is the role for that and it is what the Music app
   * uses for the same failure, so the two surfaces agree on more than the wording.
   */
  const accentClass = $derived($musicStatus === 'error' ? 'text-error' : 'text-primary');

  const openMusicApp = () => {
    // Close first: the shade is `inset-0` over the whole screen, so leaving it open would
    // land the person on the app they asked for with the shade still covering it.
    closeShade();
    openApp('music');
  };
</script>

{#if $musicSource}
  <!-- `px-6` to sit on the same gutter as the header and the tiles above; the list below
       is `px-5`, which is a scroller and indents its own rows. -->
  <div class="mb-4 px-6">
    <div
      data-testid="now-playing"
      class="bg-surface flex items-center gap-2 rounded-lg p-2"
      role="group"
      aria-label="Now playing"
    >
      <button
        type="button"
        class="hover:bg-surface-container duration-short ease-standard flex min-w-0 flex-1 items-center gap-2 rounded-lg p-1 text-left transition-colors"
        onclick={openMusicApp}
        title="Open Music"
      >
        <!-- The accent on the glyph and the status word, `text-on-surface` on the name:
             the two lines are a state and a name, and the state is the one worth finding
             at a glance. Every one of them is a role token, so they invert with the
             scheme — and the accent itself moves to `text-error` on a refused track, so
             the colour never says "normal" while the word says otherwise. -->
        <MusicNoteIcon class="{accentClass} size-icon-sm shrink-0" />
        <span class="min-w-0 flex-1">
          <span class="text-label-small {accentClass} block tracking-wider uppercase"
            >{statusLabel}</span
          >
          <!-- `font-mono` only while this is an id rather than a reported title: an id
               reads as a code and a title does not. `truncate` either way — a YouTube
               title outruns this row far more often than it fits it. -->
          <span
            class="text-body-small text-on-surface block truncate"
            class:font-mono={!labelIsTitle}>{trackLabel}</span
          >
        </span>
      </button>

      <!-- Absent rather than disabled on a failed track: the player has refused this
           video and will not change its mind, so `resumeMusic` is a no-op there and a
           button that does nothing is worse than one that is not offered. Stop, beside it,
           is the thing that still works. -->
      {#if $musicStatus !== 'error'}
        <button
          type="button"
          class="bg-surface-container text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface duration-short ease-standard shrink-0 rounded-full p-2 transition-colors"
          onclick={() => (isPlaying ? pauseMusic() : resumeMusic())}
          title={isPlaying ? 'Pause' : 'Play'}
          aria-label={isPlaying ? 'Pause' : 'Play'}
        >
          {#if isPlaying}
            <PauseIcon class="size-icon-sm" />
          {:else}
            <PlayIcon class="size-icon-sm" />
          {/if}
        </button>
      {/if}

      <!-- "Stop music", and it means exactly that: the audio stops and the queue is left
           alone. A label that read "Clear" or "Close" would be a promise this button does
           not keep in one direction or the other — see the note at the top of this file. -->
      <button
        type="button"
        class="bg-surface-container text-on-surface-variant hover:bg-surface-container-high hover:text-error duration-short ease-standard shrink-0 rounded-full p-2 transition-colors"
        onclick={stopMusic}
        title="Stop"
        aria-label="Stop music"
      >
        <StopIcon class="size-icon-sm" />
      </button>
    </div>
  </div>
{/if}
