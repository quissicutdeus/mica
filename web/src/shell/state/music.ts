import { derived, get, writable, type Readable, type Writable } from 'svelte/store';
import { usePersisted } from '../../sdk/host/usePersisted';
import { parseYouTubeSource, isPlaylistId, isVideoId } from '@shared/youtube';
import { reasonForCode, type MusicError, type MusicErrorReason } from '../../lib/musicErrors';
import { callStore } from '../../services/call';

/** Re-exported so the player's failures are named from one module — see `lib/musicErrors`. */
export type { MusicError, MusicErrorReason };

/**
 * What the phone is playing out loud, and the one place that decides it.
 *
 * MICA-111 phase 1 proved the embed; phase 3 (this) adds the queue, the transport that
 * moves through it, and the track identity that makes a list of ids readable. The
 * proximity fan-out (phase 2) and the saved-links table (phase 4) are still deliberately
 * absent — everything here is client-side and lives and dies with the session.
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
 * The queue is here for the same reason and one more: an app that owned it would lose it
 * on close, and "my queue emptied when I put my phone away" is the bug that makes a queue
 * not worth having.
 *
 * ## Intent, not truth
 *
 * `musicStatus` is what the phone has been *asked* to do. `MusicPlayer.svelte` turns each
 * change into a command to the embed, and calls `reportPlayerState` / `reportNowPlaying`
 * when the embed tells it something the phone did not ask for — a track ending, a stall,
 * or the title of what it is actually playing. Keeping the two directions in one store and
 * one vocabulary is what stops the UI from having to decide which of two disagreeing
 * states to render.
 *
 * ## Where a title comes from, and what it cost
 *
 * Nothing. It is not fetched. The `postMessage` channel phase 1 already opened for
 * playback state carries an `infoDelivery` payload with `videoData.title`, the video id
 * the player is actually on, and — for a playlist — its length and position, and
 * `MusicPlayer.svelte` was already parsing one field out of that same message. So the
 * phone learns what it is playing from the frame it is already talking to: no oEmbed call,
 * no API key, no third-party origin the shell was not already talking to, and nothing new
 * for a CSP to refuse in game.
 *
 * What that costs is that a title is *late and optional*. It arrives after the track
 * starts, only for the track that is playing, and never at all if the channel is not
 * answered in CEF. Every label therefore falls back to the id, which is what phase 1
 * showed and is still honest. It is also a string chosen by a cross-origin document:
 * `normalizeTitle` strips control characters and bounds the length, and it is rendered as
 * text by Svelte and never as markup.
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
 * What the embed says it is actually playing, as opposed to what it was handed.
 *
 * Distinct from the queue row because a playlist row *is* a list: the row is
 * `PL…`, and the thing making noise is one video inside it that the phone did not pick and
 * cannot name in advance.
 */
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

/**
 * A seek the phone wants performed, addressed by token.
 *
 * The store cannot post to the frame — `MusicPlayer.svelte` owns that conversation — and
 * "start this again" is not expressible as a change of source, because the embed is keyed
 * on its URL and repeating a track leaves the URL identical. A token the player watches is
 * the one signal that covers scrubbing, `repeat: 'one'`, and advancing to a duplicate row,
 * without reloading the frame and re-fetching a player it already has.
 */
export interface MusicSeek {
  token: number;
  seconds: number;
  /** Whether to play after landing. A scrub keeps the current state; a repeat starts. */
  resume: boolean;
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

/**
 * A title is a string a cross-origin document chose. Bounded before it reaches a layout.
 *
 * This and `normalizeTitle` sit up here with the key minter for the same reason: the
 * persisted queue is sanitised at module init, and a `const` declared below that point is
 * still in its temporal dead zone when the sanitiser reaches it. `normalizeTitle` being a
 * hoisted `function` is not enough — it reads this. That failure only appears once
 * something is actually in storage, which is to say on the second run, in game.
 */
const TITLE_MAX = 120;

function normalizeTitle(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // Written out rather than a regex over a control-character range: the escapes are the
  // kind eslint's `no-control-regex` exists to question, and the loop says the same thing
  // without an exception comment.
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f ? ' ' : ch;
  }
  const cleaned = out.replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  return cleaned.length > TITLE_MAX ? `${cleaned.slice(0, TITLE_MAX - 1)}…` : cleaned;
}

/**
 * Row identity, minted here so the persisted queue can be sanitised without changing it.
 * Declared above `sanitizeQueue` because that runs at module init, on the value read out
 * of storage, before anything below this point exists.
 */
let keySeq = 0;
const makeKey = (): string => `q${++keySeq}`;

/**
 * A queue is a list of things that end up in an `<iframe src>`, and localStorage is not a
 * trusted source for that.
 *
 * `usePersisted` runs this on the value read at startup **and on every write**, so it has
 * to be idempotent as well as strict: ids are re-checked against `shared/youtube.ts` the
 * way `embedUrlFor` re-checks them, a row that fails is dropped rather than repaired, and
 * an existing `key` is kept — minting a fresh one per write would change the identity of
 * every row on every title update, which is what `{#each}` and `removeFromQueue` address
 * rows by.
 *
 * The cap is a bound on what a restart can be made to carry, not an opinion about how many
 * tracks a person may queue in a session.
 */
const MAX_PERSISTED_ROWS = 100;

const REASONS: readonly MusicErrorReason[] = ['embed-blocked', 'unavailable', 'unplayable'];

const sanitizeRowError = (value: unknown): MusicError | null => {
  if (typeof value !== 'object' || value === null) return null;
  const { reason, code } = value as Partial<MusicError>;
  if (!REASONS.includes(reason as MusicErrorReason)) return null;
  if (typeof code !== 'number' || !Number.isFinite(code)) return null;
  return { reason: reason as MusicErrorReason, code };
};

const sanitizeQueue = (value: unknown): QueueEntry[] => {
  if (!Array.isArray(value)) return [];
  const rows: QueueEntry[] = [];
  for (const raw of value.slice(0, MAX_PERSISTED_ROWS)) {
    if (typeof raw !== 'object' || raw === null) continue;
    const row = raw as Partial<QueueEntry>;
    const videoId = typeof row.videoId === 'string' && isVideoId(row.videoId) ? row.videoId : null;
    const playlistId =
      typeof row.playlistId === 'string' && isPlaylistId(row.playlistId) ? row.playlistId : null;
    if (!videoId && !playlistId) continue;

    let key: string;
    if (typeof row.key === 'string' && row.key) {
      key = row.key;
      // Keep the minter ahead of anything that came back, or a new row could be handed a
      // key a restored one already holds.
      const seq = /^q(\d+)$/.exec(key);
      if (seq) keySeq = Math.max(keySeq, Number(seq[1]));
    } else {
      key = makeKey();
    }

    // The title survives — it is the label, and re-earning it costs another track start.
    //
    // So does the failure, which took a second look to get right. It reads like a claim
    // about a request this session has not made, and the first version of this dropped it
    // for that reason — but an uploader's embedding setting is a property of the video and
    // will be just as true tomorrow, and `sanitize` runs on **every write**, so dropping
    // it here erased a row's error the moment anything else touched the queue. It is kept,
    // and `goTo` clears a row's own verdict when it plays that row again, so retrying is
    // what un-marks it rather than a restart quietly forgetting.
    const entry: QueueEntry = {
      key,
      videoId,
      playlistId,
      title: normalizeTitle(row.title)
    };
    const failure = sanitizeRowError(row.error);
    if (failure) entry.error = failure;
    rows.push(entry);
  }
  return rows;
};

/**
 * The queue survives a restart; **nothing about it starts playing on its own.**
 *
 * `sync: false` deliberately. `musicVolume` above syncs to the player's character because
 * it is a preference, and the same is true of shuffle and repeat below. A queue is
 * *content*, and where content lives is phase 4's decision (saved links and playlists, and
 * a table to hold them) — putting it into character-synced settings storage now would
 * quietly pre-empt that with a shape nobody chose. On the phone until then.
 */
const queueStore = usePersisted<QueueEntry[]>('settings', 'musicQueue', [], {
  sanitize: sanitizeQueue,
  sync: false
});

/**
 * Which row is loaded **now**, and it is not persisted — see `resumeIndexStore`.
 *
 * Restoring this would be restoring `musicSource`, and a non-null source is an embed with
 * `autoplay=1` in the page: the phone would start playing on its own every time the
 * resource restarted, with nobody having asked for music.
 */
const indexStore = writable<number>(-1);

/**
 * Where play resumes from, which is the persistable half of "where you were".
 *
 * Written whenever a row loads and read only by `resumeMusic` when nothing is loaded, so
 * the queue comes back pointing at the track you were on and waits to be told to play.
 */
const resumeIndexStore = usePersisted<number>('settings', 'musicResumeIndex', 0, {
  sanitize: (value) =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0,
  sync: false
});
const statusStore = writable<MusicStatus>('idle');
/** Preferences, so they sync with the character the way `musicVolume` does. */
const repeatStore = usePersisted<MusicRepeat>('settings', 'musicRepeat', 'off', {
  sanitize: (value) => (value === 'all' || value === 'one' ? value : 'off')
});
const shuffleStore = usePersisted<boolean>('settings', 'musicShuffle', false, {
  sanitize: (value) => value === true
});
const nowPlayingStore = writable<MusicNowPlaying | null>(null);
const errorStore = writable<MusicError | null>(null);
const positionStore = writable<MusicPosition>({ current: 0, duration: 0 });
const seekStore = writable<MusicSeek | null>(null);

/**
 * How far music drops under a ringing phone.
 *
 * A fifth, not silence: the point of ducking rather than pausing is that the ringtone and
 * the caller's name have to win without the track stopping for a call that is about to be
 * declined. Loud enough to still be there, quiet enough not to be what you hear.
 */
const DUCK_FACTOR = 0.2;

/** True while a call is ringing and the music is turned down under it. */
const duckedStore = writable<boolean>(false);

let seekToken = 0;

/** Ask the player to move the playhead. See `MusicSeek` for why this is a token. */
const requestSeek = (seconds: number, resume: boolean): void => {
  seekStore.set({ token: ++seekToken, seconds: Math.max(0, seconds), resume });
};

/**
 * Whether the *phone* paused the music for a call, as opposed to the person doing it.
 *
 * The difference is the whole of the restore rule: music that never comes back is worse
 * than music that never stopped, and music that comes back over a pause somebody asked for
 * is worse than both.
 */
let pausedForCall = false;

/**
 * Where `previousTrack` goes back to.
 *
 * A stack of keys rather than "index − 1", because with shuffle on the track before this
 * one is not the row above it, and because a row removed from the queue must not become a
 * destination. Module scope, not a store: nothing renders it.
 */
let history: string[] = [];

/**
 * Keys already played in the current shuffle cycle.
 *
 * Shuffle is a permutation, not a die roll per track — without this a ten-track queue
 * plays the same three songs and a person notices within a minute. The cycle resets when
 * every row has been played (and only then continues, under `repeat: 'all'`).
 */
const playedThisCycle = new Set<string>();

/** What is loaded in the player, or `null` when nothing is. */
export const musicSource: Readable<MusicSource | null> = derived(
  [queueStore, indexStore],
  ([queue, index]) => {
    const entry = index >= 0 ? queue[index] : undefined;
    return entry ? { videoId: entry.videoId, playlistId: entry.playlistId } : null;
  }
);
/** What the phone has been asked to do with it. */
export const musicStatus: Readable<MusicStatus> = { subscribe: statusStore.subscribe };
/** Everything queued, in play order. */
export const musicQueue: Readable<QueueEntry[]> = { subscribe: queueStore.subscribe };
/** Which row of `musicQueue` is loaded, or `-1` when none is. */
export const musicIndex: Readable<number> = { subscribe: indexStore.subscribe };
/** What the embed reports it is actually playing. `null` until it says anything. */
export const musicNowPlaying: Readable<MusicNowPlaying | null> = {
  subscribe: nowPlayingStore.subscribe
};
/**
 * Why the loaded track will not play, or `null`. Set together with `musicStatus: 'error'`,
 * and cleared by anything that loads something else.
 */
export const musicError: Readable<MusicError | null> = { subscribe: errorStore.subscribe };
export const musicRepeat: Readable<MusicRepeat> = { subscribe: repeatStore.subscribe };
export const musicShuffle: Readable<boolean> = { subscribe: shuffleStore.subscribe };

/** Where the player says it is in the track. `duration` is `0` until it reports one. */
export const musicPosition: Readable<MusicPosition> = { subscribe: positionStore.subscribe };

/** @internal The shell's own channel to the frame — see `MusicSeek`. Not on the SDK. */
export const musicSeek: Readable<MusicSeek | null> = { subscribe: seekStore.subscribe };

/**
 * The volume the frame is actually told, as opposed to the one the person set.
 *
 * `musicVolume` is persisted and is the setting; this is the setting after ducking. They
 * are separate stores precisely because a duck must never be written back into a persisted
 * preference — a phone that missed the un-duck would otherwise leave the person's volume
 * permanently at a fifth, with the slider agreeing that that is what they asked for.
 */
export const musicOutputVolume: Readable<number> = derived(
  [musicVolume, duckedStore],
  ([volume, ducked]) => (ducked ? volume * DUCK_FACTOR : volume)
);

/** Whether music is currently turned down under a ringing phone. */
export const musicDucked: Readable<boolean> = { subscribe: duckedStore.subscribe };

const currentEntry = (): QueueEntry | null => {
  const index = get(indexStore);
  return index >= 0 ? (get(queueStore)[index] ?? null) : null;
};

const sameSource = (a: MusicSource | null, b: MusicSource | null): boolean =>
  a !== null && b !== null && a.videoId === b.videoId && a.playlistId === b.playlistId;

/**
 * Load the row at `index` and start it.
 *
 * `remember` is what separates going forward from going back: `nextTrack` pushes what it
 * left onto the history, `previousTrack` is consuming that history and must not push the
 * row it is stepping off of, or the two buttons walk between the same pair forever.
 */
function goTo(index: number, remember = true): void {
  const entry = get(queueStore)[index];
  if (!entry) return;

  const previous = currentEntry();
  if (remember && previous && previous.key !== entry.key) history.push(previous.key);

  const restart = sameSource(previous, entry);
  // Playing a row is asking again, so last time's verdict stops applying to it. Without
  // this a track that failed once wears the label for the rest of the session — and, since
  // the queue is persisted, for every session after it.
  if (entry.error) {
    queueStore.update((queue) =>
      queue.map((row) => (row.key === entry.key ? { ...row, error: null } : row))
    );
  }
  playedThisCycle.add(entry.key);
  indexStore.set(index);
  resumeIndexStore.set(index);
  positionStore.set({ current: 0, duration: 0 });
  // A different track: whatever the player last said is about the old one, failure
  // included. The row keeps its own copy, so nothing is forgotten by clearing this.
  errorStore.set(null);
  if (!restart) nowPlayingStore.set(null);
  statusStore.set('loading');
  if (restart) requestSeek(0, true);
}

const entryFor = (input: string): QueueEntry | null => {
  const parsed = parseYouTubeSource(input);
  if (!parsed) return null;
  return { key: makeKey(), videoId: parsed.videoId, playlistId: parsed.playlistId, title: null };
};

/**
 * Play whatever the player pasted, now.
 *
 * Inserted *after* the current row rather than appended, then jumped to: appending would
 * put the rest of the queue in front of it, so pressing play on a link would strand three
 * already-queued tracks behind the one thing the person asked for.
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
  const entry = entryFor(input);
  if (!entry) return;
  const index = get(indexStore);
  const at = index >= 0 ? index + 1 : get(queueStore).length;
  queueStore.update((queue) => [...queue.slice(0, at), entry, ...queue.slice(at)]);
  goTo(at);
}

/**
 * Add to the end of the queue without interrupting anything.
 *
 * Never starts playback, even from idle — a button labelled "Queue" that begins playing is
 * the wrong button. An idle phone with a queue is one tap from playing it, because the
 * transport is shown whenever the queue has rows.
 */
export function enqueue(input: string): void {
  const entry = entryFor(input);
  if (!entry) return;
  queueStore.update((queue) => [...queue, entry]);
}

/** Play a specific row. Tapping the row already playing restarts it. */
export function playQueueIndex(index: number): void {
  goTo(index);
}

/**
 * Drop a row.
 *
 * Removing the row that is playing falls through to whatever takes its place, which is
 * what a person means by it; removing anything else leaves playback alone. A stopped phone
 * stays stopped either way — a delete is not a play command.
 */
export function removeFromQueue(key: string): void {
  const queue = get(queueStore);
  const at = queue.findIndex((entry) => entry.key === key);
  if (at === -1) return;

  const index = get(indexStore);
  const remaining = queue.filter((_, i) => i !== at);
  queueStore.set(remaining);
  history = history.filter((k) => k !== key);
  playedThisCycle.delete(key);

  if (at === index) {
    // Detached first, so the row that shifts up is loaded as a genuinely new source rather
    // than mistaken for the one already playing.
    indexStore.set(-1);
    if (!remaining.length) {
      nowPlayingStore.set(null);
      statusStore.set('idle');
      return;
    }
    goTo(Math.min(at, remaining.length - 1), false);
  } else if (at < index) {
    indexStore.set(index - 1);
  }
}

/** Empty the queue and stop. */
export function clearQueue(): void {
  queueStore.set([]);
  stopMusic();
}

/**
 * Resume a paused track — or start the queue, when one is loaded and nothing is playing.
 *
 * A failed track is not resumable and saying otherwise would be a button that does
 * nothing: the player has already refused this video and will not change its mind without
 * a different video. Skip or remove it instead, which is what the screens offer.
 */
export function resumeMusic(): void {
  if (get(statusStore) === 'error') return;
  if (!currentEntry()) {
    const queue = get(queueStore);
    if (queue.length) goTo(Math.min(get(resumeIndexStore), queue.length - 1));
    return;
  }
  statusStore.set('playing');
}

/** Hold the current position. A no-op when nothing is loaded, or when it never started. */
export function pauseMusic(): void {
  if (get(statusStore) === 'error') return;
  if (!currentEntry()) return;
  statusStore.set('paused');
}

/**
 * Stop, and unload.
 *
 * Distinct from pause on purpose: clearing the loaded row is what lets
 * `MusicPlayer.svelte` tear the embed down rather than leave a silent-but-live YouTube
 * frame in the page for the rest of the session. There is no in-game reason to keep one
 * warm, and phase 1 has no evidence about what an idle embed costs a client's framerate.
 *
 * **The queue survives it.** Stop is "stop making noise", not "throw away what I lined
 * up"; `clearQueue` is the one that discards.
 */
export function stopMusic(): void {
  indexStore.set(-1);
  nowPlayingStore.set(null);
  errorStore.set(null);
  positionStore.set({ current: 0, duration: 0 });
  statusStore.set('idle');
  history = [];
  playedThisCycle.clear();
}

export function setMusicVolume(value: number): void {
  musicVolume.set(Math.max(0, Math.min(1, value)));
}

/** Off → all → one → off. One control, three states, in the order people expect them. */
export function cycleRepeat(): void {
  repeatStore.update((mode) => (mode === 'off' ? 'all' : mode === 'all' ? 'one' : 'off'));
}

export function setRepeat(mode: MusicRepeat): void {
  repeatStore.set(mode);
}

/** Flip shuffle, and start a fresh cycle so the change takes effect on the next track. */
export function toggleShuffle(): void {
  shuffleStore.update((on) => !on);
  playedThisCycle.clear();
  const entry = currentEntry();
  if (entry) playedThisCycle.add(entry.key);
}

/**
 * Which row plays after this one, or `null` for "the queue is finished".
 *
 * `repeat: 'one'` is deliberately not answered here — it is not a choice of *row*, and
 * folding it in would make "next" mean "this again", which is not what the button says.
 */
function pickNext(): number | null {
  const queue = get(queueStore);
  if (!queue.length) return null;
  const index = get(indexStore);
  const repeat = get(repeatStore);

  if (!get(shuffleStore)) {
    if (index + 1 < queue.length) return index + 1;
    return repeat === 'all' ? 0 : null;
  }

  const unplayed = queue
    .map((entry, i) => ({ entry, i }))
    .filter(({ entry, i }) => i !== index && !playedThisCycle.has(entry.key));
  if (unplayed.length) return unplayed[Math.floor(Math.random() * unplayed.length)].i;

  if (repeat !== 'all') return null;
  playedThisCycle.clear();
  const others = queue.map((_, i) => i).filter((i) => i !== index);
  if (!others.length) return index;
  return others[Math.floor(Math.random() * others.length)];
}

/**
 * Whether Next would go anywhere, so a control can refuse to offer a dead button.
 *
 * Derived over the four stores `pickNext` reads, and that is not the whole of its input —
 * it also reads `playedThisCycle`, which is a module-scope `Set` and not reactive. It works
 * because **every** mutation of that set is accompanied by a write to one of these:
 * `goTo` adds a key and sets `indexStore`, `toggleShuffle` clears it and flips
 * `shuffleStore`, `stopMusic` clears it and sets `indexStore`, `removeFromQueue` deletes
 * from it and sets `queueStore`. So there is no state in which the cycle has moved and none
 * of these has. Anything added later that touches the cycle silently must write one of them
 * too, or this store goes stale and a disabled Next button lies.
 *
 * `pickNext` is called rather than reimplemented, because a second definition of "is there
 * a next track" is a second definition that drifts — this one has to agree with the button
 * exactly, or the control is enabled when pressing it does nothing.
 */
export const musicHasNext: Readable<boolean> = derived(
  [queueStore, indexStore, repeatStore, shuffleStore],
  () => pickNext() !== null
);

/**
 * Whether Previous would go anywhere. Anything loaded, and it would.
 *
 * True rather than clever: from the first row `previousTrack` restarts it, which is what
 * every music player does with that button and is a real thing to want. There is no state
 * where something is playing and Previous does nothing, so there is nothing to disable.
 */
export const musicHasPrevious: Readable<boolean> = derived(
  [queueStore, indexStore],
  ([queue, index]) => queue.length > 0 && index >= 0
);

/** Skip forward. At the end of a queue that is not repeating, this stops. */
export function nextTrack(): void {
  const next = pickNext();
  if (next === null) {
    stopMusic();
    return;
  }
  goTo(next);
}

/**
 * Step back.
 *
 * Down the history stack first, so this undoes what actually happened rather than what the
 * list order implies — the two differ under shuffle, and after a removal. With nothing to
 * undo it walks up the list, and from the first row it restarts it, which is what every
 * other music player does with the button.
 */
export function previousTrack(): void {
  const queue = get(queueStore);
  if (!queue.length) return;

  while (history.length) {
    const key = history.pop();
    const at = queue.findIndex((entry) => entry.key === key);
    if (at !== -1) {
      goTo(at, false);
      return;
    }
  }

  const index = get(indexStore);
  if (index > 0) goTo(index - 1, false);
  else if (index === 0) goTo(0, false);
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
  if (!currentEntry()) return;
  // Once the player has said this track failed, nothing else it says about it is news.
  // Without this an `ended` arriving after an error would advance the queue — or, on a
  // one-track queue, stop and clear the message — and the failure would vanish before
  // anybody read it.
  if (get(statusStore) === 'error') return;
  if (state === 'ended') {
    advanceAfterEnd();
    return;
  }
  if (state === 'playing' && get(statusStore) === 'loading') {
    statusStore.set('playing');
  }
}

/**
 * A track finished. Decide whether that was ours to act on.
 *
 * **A playlist row is not one track, and this is where that decision is paid for.** The
 * embed advances a playlist itself (see `embedUrlFor`), and it reports `ended` between the
 * videos inside it as well as at the end of the list — so treating every `ended` as "move
 * to the next queue row" would cut a 40-track playlist off after its first song. The
 * position the player reports is what separates the two, and when it reports nothing the
 * phone holds rather than advancing: a queue that stalls at the end of a playlist is a
 * button press away from moving on, and one that skipped 39 tracks is silently broken.
 */
function advanceAfterEnd(): void {
  const entry = currentEntry();
  if (!entry) return;

  if (entry.playlistId) {
    const info = get(nowPlayingStore);
    const known = info && info.playlistIndex !== null && info.playlistCount !== null;
    if (!known || info.playlistIndex! < info.playlistCount! - 1) return;
  }

  if (get(repeatStore) === 'one') {
    requestSeek(0, true);
    return;
  }

  const next = pickNext();
  if (next === null) {
    stopMusic();
    return;
  }
  goTo(next);
}

/**
 * Where the player says it is, from the same `infoDelivery` message as everything else.
 *
 * **There is no polling here, and none is possible.** The command channel is one-way for
 * anything that would return a value: `{ func: 'getCurrentTime' }` is dispatched and never
 * answered. The official IFrame API's getters look synchronous precisely because its
 * script keeps a local cache fed by these pushes and reads that — so a poll would not be
 * expensive, it would be silent. What arrives, arrives; what does not, is not there.
 *
 * The consequence is worth stating rather than papering over: if the player pushes
 * sparsely in CEF the elapsed time steps coarsely, and the fix for that would be a local
 * timer interpolating between reports — a tick that keeps running while the phone is
 * closed, spending a client's frames on a number nobody is looking at. Not worth it before
 * somebody has watched it in game and said it looks wrong.
 */
export function reportPlayerProgress(info: { currentTime?: unknown; duration?: unknown }): void {
  if (!currentEntry()) return;
  const current = seconds(info.currentTime);
  const duration = seconds(info.duration);
  if (current === null && duration === null) return;
  positionStore.update((previous) => ({
    current: current ?? previous.current,
    // A live stream reports 0 forever, which is honest and is why the UI hides the scrubber
    // rather than drawing one that cannot move.
    duration: duration ?? previous.duration
  }));
}

const seconds = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

/**
 * Move the playhead, without changing whether the track is running.
 *
 * Bounded by the reported duration rather than trusted from the caller: the value comes
 * off a slider, and a seek past the end is how you get a track that ends the moment it is
 * touched. The position is set optimistically so the control does not snap back to the
 * last reported value while the player catches up.
 */
export function seekMusic(to: number): void {
  if (!currentEntry() || get(statusStore) === 'error') return;
  const { duration } = get(positionStore);
  const target = Math.max(0, duration > 0 ? Math.min(to, duration) : to);
  positionStore.update((previous) => ({ ...previous, current: target }));
  requestSeek(target, false);
}

/**
 * The player refusing to play what it was given.
 *
 * This is the difference between a screen that says why and a screen that says `Starting…`
 * forever — and the second one is worse than it looks, because an indefinite `Starting…`
 * is indistinguishable from CEF refusing the frame outright. Phase 1 exists to answer
 * whether the embed works in game at all, and somebody running that procedure with an
 * embedding-disabled video would otherwise conclude the whole approach is dead when the
 * truth is that one uploader ticked a box.
 *
 * The error is recorded twice on purpose: on the phone, as the state of what is loaded
 * now, and on the row, so the list still says which track is bad after moving past it.
 */
export function reportPlayerError(code: unknown): void {
  const entry = currentEntry();
  if (!entry) return;
  if (typeof code !== 'number' || !Number.isFinite(code)) return;

  const failure: MusicError = { reason: reasonForCode(code), code };
  errorStore.set(failure);
  statusStore.set('error');
  queueStore.update((queue) =>
    queue.map((row) => (row.key === entry.key ? { ...row, error: failure } : row))
  );
}

const wholeNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;

/**
 * What the player says it is playing, from the `infoDelivery` message phase 1 already
 * listens to. Nothing here is fetched; see the note at the top of this file.
 *
 * Every field is optional and merged over what is already known, because the player sends
 * several of these per track and they do not all carry the same keys. The merge is safe
 * because `goTo` clears the whole record on a track change — a merge that could outlive
 * its track would be how a previous song's title ends up over this one's.
 */
export function reportNowPlaying(info: {
  title?: unknown;
  videoId?: unknown;
  playlistIndex?: unknown;
  playlistCount?: unknown;
}): void {
  const entry = currentEntry();
  if (!entry) return;

  const title = normalizeTitle(info.title);
  const videoId = typeof info.videoId === 'string' && isVideoId(info.videoId) ? info.videoId : null;
  const playlistIndex = wholeNumber(info.playlistIndex);
  const playlistCount = wholeNumber(info.playlistCount);
  if (title === null && videoId === null && playlistIndex === null && playlistCount === null) {
    return;
  }

  nowPlayingStore.update((previous) => ({
    title: title ?? previous?.title ?? null,
    videoId: videoId ?? previous?.videoId ?? null,
    playlistIndex: playlistIndex ?? previous?.playlistIndex ?? null,
    playlistCount: playlistCount ?? previous?.playlistCount ?? null
  }));

  // The row keeps the title only when the player is on the row's *own* video. Inside a
  // playlist it is on something the row cannot name, and writing that title onto the row
  // would relabel the whole list after whichever song happened to be playing.
  if (title && videoId && entry.videoId === videoId && entry.title !== title) {
    queueStore.update((queue) =>
      queue.map((row) => (row.key === entry.key ? { ...row, title } : row))
    );
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
 *   the open question phase 1 exists to answer.
 * - `controls=0` / `disablekb=1` / `fs=0`: the frame is invisible and must never take a
 *   keypress or grow. `web/src/shell/MusicPlayer.svelte` explains why it is invisible.
 * - `rel=0` keeps the end-screen suggestions off, which matters because a suggestion is a
 *   navigation and the frame is not something the player can see to stop.
 * - `origin` is what the official IFrame API sets, and the player validates commands
 *   against it. Omitted when there is no http(s) origin to name rather than guessed.
 * - `start`, when a caller asks for one, is how a **remote** broadcast joins in progress
 *   (MICA-111 phase 2, `state/nearbyMusic.ts`). It is a URL parameter rather than a
 *   `seekTo` after load on purpose: a seek is a second command racing the autoplay it is
 *   trying to correct, and the audible failure mode is the first seconds of the track
 *   playing before the jump. The phone's own playback never passes one — it starts where
 *   it was told to and seeks by token.
 */
export function embedUrlFor(
  source: MusicSource,
  origin?: string,
  options: { start?: number } = {}
): string | null {
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

  // Re-bounded here rather than trusted, for the same reason every id above is: this is
  // the one place a value becomes part of a URL the browser navigates. A non-integer or a
  // negative is dropped rather than coerced — `start=NaN` is a parameter YouTube is free
  // to interpret however it likes.
  const start = options.start;
  if (typeof start === 'number' && Number.isFinite(start) && start > 0) {
    params.set('start', String(Math.floor(start)));
  }

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
  queueStore.set([]);
  indexStore.set(-1);
  statusStore.set('idle');
  nowPlayingStore.set(null);
  errorStore.set(null);
  positionStore.set({ current: 0, duration: 0 });
  seekStore.set(null);
  seekToken = 0;
  duckedStore.set(false);
  pausedForCall = false;
  repeatStore.set('off');
  shuffleStore.set(false);
  resumeIndexStore.set(0);
  history = [];
  playedThisCycle.clear();
}

/**
 * Music gets out of the way of a call. MICA-111, and MICA-63's other half.
 *
 * MICA-63 shipped calls that break through Do Not Disturb, on the reasoning that a
 * missed call is the failure worth preventing — and that reasoning is undone if the phone
 * then plays music over its own ringtone. On speakerphone it is worse than a missed call:
 * it is music over the conversation.
 *
 * **Ducked while ringing, paused once connected**, and the split is not a compromise
 * between the two. A ring is an interruption the person has not accepted yet — most calls
 * are declined or missed, and stopping a track dead for one of those is heavy-handed, so
 * the music drops under the ringtone and comes straight back up. A connected call is
 * different in kind: they are talking, there is nothing to come back to for the length of
 * it, and a track running quietly under a conversation is just a worse conversation.
 *
 * **Restoring is the part that has to be right.** Music that never comes back is worse
 * than music that never stopped, so the pause is remembered as the phone's rather than the
 * person's, and it is only undone if the phone is still in the state it was left in. If
 * they pressed pause themselves during the call, or stopped it, or started something else,
 * the call ending is not an instruction to override any of that.
 *
 * Subscribed at module scope, which on a page CEF never unloads means for the session — a
 * subscription inside a component would stop hearing about calls the moment the phone was
 * closed, which is exactly when music is still playing and nobody is watching.
 */
callStore.subscribe(({ status }) => {
  // Every state but idle, and the `connected` half of that is phase 2's doing. Your own
  // music is *paused* on a connected call, so ducking it changes nothing audible here —
  // but `musicOutputVolume` is also what nearby broadcasts are played at
  // (`NearbyMusicFrame.svelte`), and somebody else's music running at full volume under a
  // conversation is the failure this whole block exists to prevent. It is ducked rather
  // than silenced because it is the world's sound and not your phone's content: a bar does
  // not go quiet because you took a call in it.
  duckedStore.set(status !== 'idle');

  if (status === 'connected') {
    if (!pausedForCall && (get(statusStore) === 'playing' || get(statusStore) === 'loading')) {
      pausedForCall = true;
      pauseMusic();
    }
    return;
  }

  if (status === 'idle' && pausedForCall) {
    pausedForCall = false;
    // Only what the phone did, and only if nothing has happened since.
    if (get(statusStore) === 'paused') resumeMusic();
  }
});
