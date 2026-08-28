import { get, writable, type Readable, type Writable } from 'svelte/store';
import { usePersisted } from '../../sdk/host/usePersisted';
import { parseYouTubeSource, isPlaylistId, isVideoId } from '@shared/youtube';

/**
 * What the phone is playing out loud, and the one place that decides it.
 *
 * MICA-111 phase 1: local playback only — the player hears their own music and nobody
 * else does. The proximity fan-out, the queue and the saved-links table are phases 2–4 and
 * deliberately absent; what phase 1 exists to answer is whether a YouTube embed works in
 * FiveM's CEF at all, and none of that work is worth writing before it does.
 *
 * ## Why this is shell state rather than the Music app's
 *
 * The CEF page loads at resource start and never unloads (AGENTS.md §8), so closing the
 * phone destroys components, not module scope. Music is expected to keep playing when the
 * phone goes down — which means the element producing it must not be inside anything the
 * close tears down. `ToastHost` and every app live under `Shell.svelte`'s `{#if visible}`
 * block and are destroyed on close, so the player is mounted *outside* it and driven from
 * here. The Music app is a controller over this state and owns none of it.
 *
 * ## Intent, not truth
 *
 * `musicStatus` is what the phone has been *asked* to do. `MusicPlayer.svelte` turns each
 * change into a command to the embed, and calls `reportPlayerState` when the embed tells
 * it something the phone did not ask for — a track ending, or a buffering stall. Keeping
 * the two directions in one store and one vocabulary is what stops the UI from having to
 * decide which of two disagreeing states to render.
 */

export type MusicStatus = 'idle' | 'loading' | 'playing' | 'paused';

export interface MusicSource {
  /** The video to play, or `null` for a playlist opened at its first entry. */
  videoId: string | null;
  /** The playlist to play through, when the pasted link named one. */
  playlistId: string | null;
}

/** The origin every embed is loaded from and every command is addressed to. */
export const YOUTUBE_EMBED_ORIGIN = 'https://www.youtube-nocookie.com';

/**
 * Origins a message from the player may legitimately arrive from.
 *
 * `youtube.com` is here beside the nocookie origin because the player has historically
 * posted from either depending on which document ended up loaded; an allowlist of two
 * constants is still an allowlist, and `event.origin` is checked against it before any
 * payload is read.
 */
export const YOUTUBE_MESSAGE_ORIGINS: readonly string[] = [
  YOUTUBE_EMBED_ORIGIN,
  'https://www.youtube.com'
];

const sanitizeVolume = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.5;
};

/**
 * Music's own volume, deliberately not `soundVolume`.
 *
 * `shell/state/audio.ts` owns the phone's UI effects — clicks, the ringtone, the
 * notification chime — and turning those down to hear yourself think should not silence a
 * track, nor the other way round. The ticket puts a proper channel with a HUD in phase 4;
 * this is that channel's value, stored under `settings` beside `soundVolume` so the two
 * migrate together when it arrives.
 */
export const musicVolume: Writable<number> = usePersisted<number>('settings', 'musicVolume', 0.5, {
  sanitize: sanitizeVolume
});

const sourceStore = writable<MusicSource | null>(null);
const statusStore = writable<MusicStatus>('idle');

/** What is loaded in the player, or `null` when nothing is. */
export const musicSource: Readable<MusicSource | null> = { subscribe: sourceStore.subscribe };
/** What the phone has been asked to do with it. */
export const musicStatus: Readable<MusicStatus> = { subscribe: statusStore.subscribe };

/**
 * Load and start whatever the player pasted.
 *
 * Anything that is not a YouTube video or playlist is dropped, and nothing already loaded
 * is disturbed. Deliberately silent, and deliberately not a `boolean`: a UI is expected to
 * have asked `isYouTubeSource` first and said so in its own words, and the parse here is
 * the second check rather than the reporting one. The shape also has to survive the add-on
 * seam, where this call is a `postMessage` and could only ever answer asynchronously.
 *
 * The ids are all that is kept. See `shared/youtube.ts` for why the URL never is.
 */
export function playSource(input: string): void {
  const parsed = parseYouTubeSource(input);
  if (!parsed) return;
  sourceStore.set({ videoId: parsed.videoId, playlistId: parsed.playlistId });
  statusStore.set('loading');
}

/** Resume a paused track. A no-op when nothing is loaded. */
export function resumeMusic(): void {
  if (!get(sourceStore)) return;
  statusStore.set('playing');
}

/** Hold the current position. A no-op when nothing is loaded. */
export function pauseMusic(): void {
  if (!get(sourceStore)) return;
  statusStore.set('paused');
}

/**
 * Stop, and unload.
 *
 * Distinct from pause on purpose: clearing the source is what lets `MusicPlayer.svelte`
 * tear the embed down rather than leave a silent-but-live YouTube frame in the page for
 * the rest of the session. There is no in-game reason to keep one warm, and phase 1 has
 * no evidence about what an idle embed costs a client's framerate.
 */
export function stopMusic(): void {
  sourceStore.set(null);
  statusStore.set('idle');
}

export function setMusicVolume(value: number): void {
  musicVolume.set(Math.max(0, Math.min(1, value)));
}

/**
 * The embed telling us something the phone did not ask for.
 *
 * Only the transitions that are genuinely news are honoured. A `playing` report while the
 * status already says `playing` is not a change, and a report that contradicts a command
 * still in flight (`paused` arriving just after the player hit play) would fight the
 * intent it is racing — so `ended` is the one that always wins, because nothing else can
 * tell us a track finished.
 */
export function reportPlayerState(state: 'playing' | 'paused' | 'ended' | 'buffering'): void {
  if (!get(sourceStore)) return;
  if (state === 'ended') {
    stopMusic();
    return;
  }
  if (state === 'playing' && get(statusStore) === 'loading') {
    statusStore.set('playing');
  }
}

/**
 * The `src` of the embed, built from validated ids and nothing else.
 *
 * Every id is re-checked here rather than trusted from the store. It is the same check
 * `parseYouTubeSource` already did, and that is the point: this function is the single
 * place a player-supplied value is interpolated into a URL that the browser will
 * *navigate*, so it does not depend on a caller elsewhere having been careful. A value
 * that fails returns `null` and the player renders no frame at all.
 *
 * Parameter choices, since none of them is obvious:
 * - `enablejsapi=1` is what makes the `postMessage` control channel exist at all.
 * - `autoplay=1` because the phone has already decided to play; whether CEF honours it is
 *   the open question this phase exists to answer.
 * - `controls=0` / `disablekb=1` / `fs=0`: the frame is invisible and must never take a
 *   keypress or grow. `web/src/shell/MusicPlayer.svelte` explains why it is invisible.
 * - `rel=0` keeps the end-screen suggestions off, which matters because a suggestion is a
 *   navigation and the frame is not something the player can see to stop.
 * - `origin` is what the official IFrame API sets, and the player validates commands
 *   against it. Omitted when there is no http(s) origin to name rather than guessed.
 */
export function embedUrlFor(source: MusicSource, origin?: string): string | null {
  const videoId = source.videoId && isVideoId(source.videoId) ? source.videoId : null;
  const playlistId =
    source.playlistId && isPlaylistId(source.playlistId) ? source.playlistId : null;
  if (!videoId && !playlistId) return null;

  const params = new URLSearchParams({
    enablejsapi: '1',
    autoplay: '1',
    playsinline: '1',
    controls: '0',
    disablekb: '1',
    fs: '0',
    rel: '0',
    iv_load_policy: '3'
  });
  if (playlistId) {
    params.set('list', playlistId);
    // `listType=playlist` is required alongside `list` on the `videoseries` path; harmless
    // and correct on a video path too, where the video is the entry point into the list.
    params.set('listType', 'playlist');
  }
  if (origin && /^https?:\/\//.test(origin)) params.set('origin', origin);

  // `videoseries` is YouTube's own placeholder path for "a playlist with no entry video".
  const path = videoId ?? 'videoseries';
  return `${YOUTUBE_EMBED_ORIGIN}/embed/${path}?${params.toString()}`;
}

/**
 * One command for the embed's `postMessage` channel.
 *
 * This is the IFrame Player API's own wire format, addressed by hand — see the decision
 * recorded at the top of `MusicPlayer.svelte` for why the phone speaks it directly rather
 * than loading YouTube's script to speak it for us.
 */
export function playerCommand(func: string, args: readonly unknown[] = []): string {
  return JSON.stringify({ event: 'command', func, args });
}

/** @internal Test-only: put the stores back to a fresh page's state. */
export function resetMusicForTest(): void {
  sourceStore.set(null);
  statusStore.set('idle');
}
