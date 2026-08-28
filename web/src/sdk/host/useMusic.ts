import './inProcess/facets/music';
import { guarded } from './guard';

/**
 * Control the phone's music playback (MICA-111).
 *
 * The player itself is the shell's, mounted outside everything the phone's close tears
 * down, so an app that opens and closes cannot interrupt a track. What this hands over is
 * the intent — what to load, and whether it should be running — plus the status to render
 * from. There is no handle on the underlying element by design; see
 * `inProcess/facets/music.ts` for what is withheld and why.
 *
 * `playSource` takes whatever a person pasted and reduces it to a YouTube video or
 * playlist id before anything is stored, then plays it. `enqueue` is the same parse
 * without the interruption. Neither reports back — ask `canPlay` first, which is pure and
 * synchronous on both sides of the add-on seam, so an app can refuse a bad paste in its
 * own words rather than silently doing nothing.
 *
 * **The queue is the shell's, and it outlives the app.** Closing the phone destroys every
 * component and none of this state, which is the point: a queue an app owned would empty
 * itself the moment the phone went into a pocket. A row is identified by its `key`, not by
 * its video id, because the same track queued twice is two rows.
 *
 * **A title is late, optional, and never fetched.** It arrives from the player itself over
 * the channel the shell already has open, after the track starts, and only for the track
 * that is playing — so `musicNowPlaying` is `null` at first and may stay `null` in CEF.
 * Every label an app draws needs a fallback to the id. A playlist row is the sharper case:
 * the row is a `PL…` id and the thing making noise is a video inside it that the phone did
 * not choose, so the row's own `title` stays `null` while `musicNowPlaying` names what is
 * actually playing.
 *
 * **Position is pushed, never polled.** `musicPosition` updates when the player reports,
 * and there is no way to ask it — the command channel does not answer getters. Treat a
 * `duration` of `0` as "no scrubber", not as "zero seconds long".
 *
 * **A track can refuse to play, and the app has to say so.** `musicStatus: 'error'` with
 * a `musicError` is a state on its own, not a variety of stopped — YouTube reports 101 or
 * 150 when the uploader disabled embedding, which covers a lot of real music, and 100 when
 * the video is gone. `describeMusicError` is the shared wording. Do not render an errored
 * track as loading: the phone's own in-game test procedure depends on that distinction.
 *
 * **Phase 1 is local playback: the person hears their own music and nobody else does.**
 * There is no proximity broadcast behind this yet, and an app should not imply one.
 */
export function useMusic() {
  return guarded('useMusic').facets.music();
}

/** @public — SDK surface for add-ons; no in-repo app needs to name it. */
export type {
  MusicError,
  MusicErrorReason,
  MusicNowPlaying,
  MusicPosition,
  MusicRepeat,
  MusicSource,
  MusicStatus,
  QueueEntry
} from './inProcess/facets/music';
