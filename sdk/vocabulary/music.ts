import type { MusicError } from '../lib/musicErrors';

/**
 * The playback and nearby-broadcast nouns `Facets['music']` is written in. MICA-172 —
 * see `./accounts.ts` for why these are declared inside the package.
 *
 * `MusicError` and `MusicErrorReason` are **not** here: they already live in
 * `sdk/lib/musicErrors.ts`, inside the package, and `shell/state/music.ts` was re-exporting
 * them — the phone republishing an SDK type. `facets.ts` now names them at their real home.
 */

export type MusicStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'error';

/** How the queue behaves when a track ends. */
export type MusicRepeat = 'off' | 'all' | 'one';

export interface MusicSource {
  /** The video to play, or `null` for a playlist opened at its first entry. */
  videoId: string | null;
  /** The playlist to play through, when the pasted link named one. */
  playlistId: string | null;
}

/**
 * One row of the queue.
 *
 * `key` rather than the video id, because the same track queued twice is two rows a person
 * can reorder past or remove independently, and because a playlist entry has no video id
 * at all. Every reference the queue holds internally — the history stack, the shuffle
 * cycle — is a key for that reason.
 */
export interface QueueEntry extends MusicSource {
  key: string;
  /**
   * Why this row would not play, once it has failed. Kept on the row rather than only in
   * `musicError` so the reason survives moving on to the next track — a list where the bad
   * row still says what is wrong with it is a list a person can act on.
   */
  error?: MusicError | null;
  /**
   * What the player reported for this row, once it has played it. `null` until then, and
   * for a playlist row always — see `MusicNowPlaying.title` for what a playlist is on.
   */
  title: string | null;
}

/**
 * Where the player says it is in the current track, in seconds.
 *
 * Separate from `MusicNowPlaying` on purpose: this changes constantly and that does not,
 * and a title line that re-renders on every position report is a title line that flickers.
 */
export interface MusicPosition {
  current: number;
  /** `0` until the player reports one — a live stream never will. */
  duration: number;
}

export interface MusicNowPlaying {
  /** The reported title, normalized. `null` until the player says one. */
  title: string | null;
  /** The video the player is on. Inside a playlist this is not the row's own id. */
  videoId: string | null;
  /** Position inside a playlist the embed is advancing itself, when it reports one. */
  playlistIndex: number | null;
  /** How many entries that playlist has, when it reports one. */
  playlistCount: number | null;
}

/**
 * One person the phone has been told is playing something within earshot.
 *
 * Structurally the wire's `NearbyBroadcast` (`@gphone/shared/musicBroadcast`) and re-declared
 * rather than imported, because this is the shape *after* narrowing: every field here has
 * been re-checked against `shared/youtube.ts` and bounded, and a row that failed is not
 * here at all. The names are the wire's on purpose — three lanes touch this row and a
 * rename at any hop is a place for two vocabularies to disagree.
 */
export interface NearbyBroadcast {
  /** The broadcaster's FiveM server id. Used here only to look up their volume. */
  source: number;
  /** Who is broadcasting, stable across a reconnect. The mute key, and every store's key. */
  token: string;
  /** What to call them in the mute list. `null` when the server did not say. */
  label: string | null;
  videoId: string | null;
  playlistId: string | null;
  /** Server clock, ms. What `joinOffsetSeconds` measures from. */
  startedAt: number;
  /** Whether they have paused it. Held rather than torn down — see `NearbyMusicFrame`. */
  paused: boolean;
}

/** A broadcast that won the cap, with the two numbers needed to actually play it. */
export interface AudibleBroadcast extends NearbyBroadcast {
  /** The game client's distance attenuation, 0..1. Multiplied by the music volume. */
  attenuation: number;
  /**
   * Seconds into the source to start at.
   *
   * Fixed when the source appeared and **not** recomputed on a volume tick — see
   * `offsets` in `shell/state/nearbyMusic.ts`, which is the difference between one frame
   * and a frame per tick.
   */
  startAt: number;
}
