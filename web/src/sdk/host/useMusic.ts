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
 * **Other people's music is a different thing, and the hook says so.** `nearbyBroadcasts`
 * is who is playing something within earshot and `audibleBroadcasts` is the subset this
 * phone is actually rendering — after the mute list, and after a cap of
 * `maxAudibleBroadcasts` on how many play at once, nearest first. There is no transport
 * for them and there never will be: a broadcast has no queue you can see, no position you
 * may move, and no error you could do anything about. The two things an app may offer are
 * `muteBroadcaster` (per person, persisted across sessions) and `setMuteAllNearby` (the
 * standing switch somebody reaches for when they are being harassed and do not care by
 * whom). Muting is local, is never sent anywhere, and the broadcaster is not told.
 *
 * **Mute against `token`, never `source`.** A row carries both: `token` is an opaque,
 * stable handle on the person and is the only thing `muteBroadcaster` accepts; `source` is
 * a FiveM server id, a connection the server reuses, and a mute keyed there is void the
 * moment its target relogs. A `token` survives a reconnect and not a resource restart,
 * which is the right trade — mute evasion is a relog, not an `ensure`.
 *
 * **A broadcast is anonymous unless the server named it.** `label` is optional and `null`
 * is normal; neither `token` nor `source` is something to put on a screen. There is also
 * no *title* for a remote source — the title channel is the local player's own frame, and
 * a stranger's is not talking to this phone — so a nearby row is named by its person or by
 * nothing, and the artwork from `thumbnailUrlFor` is often all there is to look at.
 */
export function useMusic() {
  return guarded('useMusic').facets.music();
}

/** @public — SDK surface for add-ons; no in-repo app needs to name it. */
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
} from './inProcess/facets/music';
