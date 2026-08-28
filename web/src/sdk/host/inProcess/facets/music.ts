import { registerFacet } from '../../current';
import {
  musicSource,
  musicStatus,
  musicVolume,
  musicQueue,
  musicIndex,
  musicNowPlaying,
  musicError,
  musicPosition,
  musicRepeat,
  musicShuffle,
  musicHasNext,
  musicHasPrevious,
  playSource,
  enqueue,
  playQueueIndex,
  removeFromQueue,
  clearQueue,
  nextTrack,
  previousTrack,
  seekMusic,
  cycleRepeat,
  setRepeat,
  toggleShuffle,
  pauseMusic,
  resumeMusic,
  stopMusic,
  setMusicVolume,
  type MusicError,
  type MusicErrorReason,
  type MusicNowPlaying,
  type MusicPosition,
  type MusicRepeat,
  type MusicSource,
  type MusicStatus,
  type QueueEntry
} from '../../../../shell/state/music';
import {
  audibleBroadcasts,
  clearMutedBroadcasters,
  muteAllNearby,
  muteBroadcaster,
  mutedBroadcasters,
  nearbyBroadcasts,
  setMuteAllNearby,
  toggleBroadcasterMute,
  toggleMuteAllNearby,
  unmuteBroadcaster,
  type AudibleBroadcast,
  type NearbyBroadcast
} from '../../../../shell/state/nearbyMusic';
import { MAX_AUDIBLE_BROADCASTS } from '../../../../lib/musicBroadcast';
import { isYouTubeSource, thumbnailUrlFor } from '@shared/youtube';
import { describeMusicError } from '../../../../lib/musicErrors';

export type {
  AudibleBroadcast,
  MusicError,
  MusicErrorReason,
  MusicNowPlaying,
  MusicPosition,
  MusicRepeat,
  MusicSource,
  MusicStatus,
  NearbyBroadcast,
  QueueEntry
};

/**
 * Implementation of the `useMusic` facet — see the `useMusic` hook doc for the contract.
 *
 * Deliberately no `embedUrlFor`, no `playerCommand`, no `reportPlayerState` and no
 * `reportNowPlaying`. Those are the shell's conversation with the embed; an app that could
 * build a `src`, post a command to the frame, or tell the phone a track had ended would be
 * an app that could point the player at a URL of its own and drive the queue off it, which
 * is exactly what `shared/youtube.ts` exists to prevent. The app gets an intent and a
 * status, and the shell decides what that means.
 *
 * `thumbnailUrlFor` is the one URL builder that does cross, and it is not the shell's: it
 * comes from `shared/youtube.ts`, is pure, and produces an `<img src>` on YouTube's
 * thumbnail host from a re-validated id. An app that can already read `musicQueue` could
 * build the same string by hand; handing it over means one implementation of "which size,
 * which host" rather than one per app, and it answers synchronously on both sides of the
 * seam for the same reason `canPlay` does.
 */
export function music() {
  return {
    /** What is loaded, as ids. `null` when nothing is. */
    musicSource,
    /** Everything queued, in play order. */
    musicQueue,
    /** Which row of `musicQueue` is loaded, or `-1` when none is. */
    musicIndex,
    /**
     * What the embed reports it is actually playing — the title and the video id, plus a
     * position inside a playlist row. `null` until it says anything, and it may never:
     * every label an app draws from this needs a fallback to the id.
     */
    musicNowPlaying,
    /**
     * Why the loaded track will not play, or `null`. Set together with
     * `musicStatus: 'error'`, so an app can render one or the other and never both.
     */
    musicError,
    /**
     * Where the player says it is, in seconds. `duration` is `0` until it reports one and
     * stays `0` for a live stream, which is the signal to draw no scrubber rather than a
     * scrubber that cannot move.
     */
    musicPosition,
    /** Whether a finished queue repeats, repeats one track, or stops. */
    musicRepeat,
    musicShuffle,
    /**
     * Whether `nextTrack`/`previousTrack` would go anywhere.
     *
     * Exposed because a transport that cannot ask this has to offer the control anyway,
     * and at the end of a queue that is not repeating `nextTrack` *stops* rather than
     * advancing — a button whose label says one thing and whose effect is another.
     * `musicHasNext` is `pickNext() !== null`, the same function the button calls, rather
     * than a second opinion about it; `musicHasPrevious` is true whenever anything is
     * loaded, because from the first row Previous restarts the track.
     */
    musicHasNext,
    musicHasPrevious,
    /** What the phone has been asked to do with it. */
    musicStatus,
    /** Music's own volume, 0–1 — not the phone's UI-sound volume. */
    musicVolume,
    /**
     * Is this string a YouTube video or playlist link? Pure, synchronous, and answered
     * locally on both sides of the add-on seam — ask this before `playSource` so the app
     * can report a bad paste in its own words.
     */
    canPlay: isYouTubeSource,
    /**
     * Play it now: inserted after whatever is playing, and jumped to. Silently drops
     * anything `canPlay` would have refused.
     */
    playSource,
    /** Add it to the end of the queue without interrupting anything, and without starting. */
    enqueue,
    /** Play a specific row. The row already playing restarts. */
    playQueueIndex,
    /** Drop a row by its `key`. Removing the row that is playing falls through to the next. */
    removeFromQueue,
    /** Empty the queue and stop. `stopMusic` alone keeps it. */
    clearQueue,
    nextTrack,
    previousTrack,
    /** Move the playhead, in seconds. Bounded by the reported duration; does not resume. */
    seekMusic,
    /** Off, then all, then one. */
    cycleRepeat,
    setRepeat,
    toggleShuffle,
    /** The still frame for a video id, or `null`. A plain image; no API key, no script. */
    thumbnailUrlFor,
    /**
     * One phrase for a failure, shared so three screens cannot invent three wordings for
     * the same refusal. Pure and synchronous on both sides of the seam.
     */
    describeMusicError,
    pauseMusic,
    resumeMusic,
    stopMusic,
    setMusicVolume,

    /**
     * Other people's music (MICA-111 phase 2), and everything an app may do about it.
     *
     * Read-and-mute, and nothing else, because there is nothing else to offer: a broadcast
     * has no queue you can see, no position you may move and no error you could fix. The
     * transport above is for this phone's own playback and deliberately does not accept a
     * broadcaster id — an app that could pause a stranger's music would be an app that
     * could pause a stranger's music.
     */
    nearbyBroadcasts,
    /** The ones actually playing: not muted, in earshot, and inside the cap. */
    audibleBroadcasts,
    /**
     * How many play at once. Exposed so a screen can *say* the rule — "playing the closest
     * three" — rather than leaving a person to discover it by counting.
     */
    maxAudibleBroadcasts: MAX_AUDIBLE_BROADCASTS,
    /** Broadcaster tokens this phone refuses to play. Never server ids — see `useMusic`. */
    mutedBroadcasters,
    /** Whether every nearby broadcast is silenced, whoever it belongs to. */
    muteAllNearby,
    muteBroadcaster,
    unmuteBroadcaster,
    toggleBroadcasterMute,
    /** Forget every individual mute. Leaves `muteAllNearby` alone; it is its own switch. */
    clearMutedBroadcasters,
    setMuteAllNearby,
    toggleMuteAllNearby
  };
}

registerFacet('music', music);
