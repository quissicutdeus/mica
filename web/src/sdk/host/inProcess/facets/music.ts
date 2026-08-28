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
import { isYouTubeSource, thumbnailUrlFor } from '@shared/youtube';
import { describeMusicError } from '../../../../lib/musicErrors';

export type {
  MusicError,
  MusicErrorReason,
  MusicNowPlaying,
  MusicPosition,
  MusicRepeat,
  MusicSource,
  MusicStatus,
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
    setMusicVolume
  };
}

registerFacet('music', music);
