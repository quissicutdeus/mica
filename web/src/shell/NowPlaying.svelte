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
   * ## It is the Music app's card, not a smaller relative of it
   *
   * This file used to draw its own version — no artwork, no shuffle, no repeat, a
   * different word for the same failure — and the difference was drift rather than design.
   * The card is now `NowPlayingCard` from `@gphone/sdk/core`, the same component the Music
   * app draws, in its `compact` mode: the same wording, the same controls under the same
   * conditions, the same album-art tint, and less padding, because here it sits above a
   * scrolling list of notifications. Everything about why the card looks and behaves as it
   * does is in that component; this file is the shell's half — which stores it reads,
   * which theme mode it is drawn in, and what tapping the name does.
   *
   * ## What Stop means here, deliberately
   *
   * `stopMusic` silences and unloads the player; **the queue survives it**, and
   * `clearQueue` is the one that discards. The card offers the first and never the second,
   * and that asymmetry with the Music app's own Clear button is the point rather than an
   * oversight.
   *
   * The shade is the low-deliberation surface: it is one pull from any screen and it is
   * where somebody reaches mid-conversation to kill the noise. Everything that happens
   * there should be recoverable, and this is — press play in the app and the queue is
   * where it was. Discarding eight queued tracks from a one-tap control with no
   * confirmation and no undo is not, and the app already has a screen's worth of room to
   * ask that question properly. `stops the audio and keeps the queue` in the test file is
   * what says so, because "stop should obviously also clear" is a plausible-sounding
   * change somebody will make later.
   *
   * ## This card is the player's own music, and structurally cannot be anything else
   *
   * Phase 2 put other people's music on the phone, and a transport control over a
   * stranger's stereo would be absurd. There is no gate here because there is nothing to
   * gate: this reads `musicSource`, which is derived from the local queue in
   * `state/music.ts`, and `state/nearbyMusic.ts` neither writes it nor shares a store with
   * it — a remote broadcast cannot reach this component without somebody wiring one in on
   * purpose. A runtime check would be a branch that can never be true and would read as
   * though it could.
   *
   * What holds that is a test rather than a comment: `NowPlaying.test.ts` renders this with
   * a nearby broadcast playing and nothing else, and fails if the card appears at all.
   */
  import {
    musicError,
    musicHasNext,
    musicHasPrevious,
    musicNowPlaying,
    musicPosition,
    musicRepeat,
    musicShuffle,
    musicSource,
    musicStatus
  } from './state/music';
  import {
    cycleRepeat,
    nextTrack,
    pauseMusic,
    previousTrack,
    resumeMusic,
    seekMusic,
    stopMusic,
    toggleShuffle
  } from './state/music';
  import { themeStore } from './state/theme';
  import { openApp } from './state/navigation';
  import { closeShade } from './state/shade';
  import { NowPlayingCard } from '@gphone/sdk/core';

  /**
   * The stores the card renders from, as one object.
   *
   * The Music app hands the card `useMusic()`; the shell has no host to ask and no need of
   * one, so it hands over the same stores directly. The shape is checked at this call site
   * — a store the card starts reading and this literal does not carry is a type error
   * here, not a blank space in the shade.
   */
  const music = {
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
  };

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
  <div class="mb-4 px-6" data-testid="now-playing" role="group" aria-label="Now playing">
    <NowPlayingCard {music} mode={$themeStore.mode} compact onopen={openMusicApp} />
  </div>
{/if}
