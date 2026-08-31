import { derived, get, writable, type Readable, type Writable } from 'svelte/store';
import { usePersisted } from '../../../../sdk/host/usePersisted';
import { isPlaylistId, isVideoId } from '@shared/youtube';
import { MAX_NEARBY_BROADCASTS } from '@shared/musicBroadcast';
import type { AudibleBroadcast, NearbyBroadcast } from '@gphone/sdk';
import {
  MAX_AUDIBLE_BROADCASTS,
  joinOffsetSeconds,
  rankAudible
} from '../../../../sdk/lib/musicBroadcast';

/**
 * Other people's music. MICA-111 phase 2, the phone's half.
 *
 * ## This is not `state/music.ts` with a flag on it
 *
 * Everything in `state/music.ts` is the phone's *own* playback: a queue, a position, a
 * repeat mode, a seek the person asked for, an error they can act on. A broadcast from
 * somebody standing next to you shares none of that. It has no queue — you cannot see
 * theirs and would not be allowed to reorder it. It has no seek — the position is not
 * yours to move. It has no repeat, no shuffle, no previous track, and no error worth
 * showing, because there is nothing you could do about a video whose uploader disabled
 * embedding on a phone that is not yours.
 *
 * It has exactly two things you *can* do to it, and they are the two this module is for:
 * **hear it, or mute it.**
 *
 * So it is a separate module with a separate vocabulary rather than a `remote: true` on
 * `MusicSource`. The flag version would have put a null check in front of every transport
 * function in `music.ts` — `seekMusic` on someone else's stream, `nextTrack` on a queue
 * that is not yours — and every one of those checks would have been a place for the two
 * concepts to leak into each other. What the two genuinely share is the **element**: a
 * YouTube embed, handshaken and volume-controlled the same way, which is
 * `MusicFrame.svelte` and is imported by both sides.
 *
 * ## The contract this codes against
 *
 * Two NUI messages, from two different senders, both defined in
 * `shared/musicBroadcast.ts`, and the split is deliberate:
 *
 * - **The server** pushes the roster — who is broadcasting, the source ids, `startedAt`
 *   and whether they have paused. It knows who is in range of whom and it holds the clock
 *   that makes `startedAt` mean anything. It sends **no volume**, because it does not know
 *   where anybody is standing this frame.
 * - **The game client** pushes a volume per broadcaster, already attenuated for distance,
 *   on its own tick. That is `client/game/` work — GTA world state, not phone state — and
 *   it is the only thing in the system that knows how far away anybody is.
 *
 * The phone applies both and decides nothing about range. What it *does* decide is who is
 * worth an iframe (`lib/musicBroadcast.ts`) and who has been silenced (below).
 *
 * ## Muting is client-side, and that is a decision rather than an accident
 *
 * A mute never reaches the server. Nothing is asked for, nothing is enforced anywhere
 * else, and the broadcaster is never told — a mute that announced itself would be a worse
 * thing to hand someone being harassed than no mute at all. It is a local statement about
 * what this phone will render, so it works when the server is busy, cannot be refused, and
 * takes effect on the next frame.
 *
 * ### Three identities, and the one the mute is keyed on
 *
 * A roster row carries `source`, `token` and `label`, and confusing any two of them is a
 * bug with a long fuse. `client/services/Music.ts` sets out the same three from the other
 * side; the short version, and what each is used for *here*:
 *
 * - **`token`** is an opaque handle on the person, stable across a reconnect and a change
 *   of server id, and meaningless off-server. It is the mute key, the identity every store
 *   below is keyed on, and what `NearbyMusicPlayer` keys its `{#each}` on.
 * - **`source`** is a FiveM server id — a *connection*, not a person. It is used for
 *   exactly one thing on this side: looking a broadcast up in the volume map, which the
 *   game client keys on `source` because a server id is the only handle it can measure a
 *   distance to.
 * - **`label`** is a display name and is never a key. It may be `null`.
 *
 * **A server id would be the wrong mute key in both directions.** FiveM reuses them: a
 * mute keyed on one is void the moment its target relogs — precisely the person a mute
 * exists for — and a *stored* one would eventually silence whichever innocent player
 * inherited the slot, with no way for them to find out why nobody could hear them.
 *
 * Not the citizenid either, and that is a standing repo decision rather than this lane's
 * preference: `defineService`'s public projection strips it everywhere, because once a
 * stable real identity reaches nearby clients it is available to any modified client for
 * correlation across characters and sessions. The token gives a mute list the only thing it
 * ever needed — *this is the same somebody as last time* — and discloses nothing else.
 *
 * So the mute list is persisted, and its durability is exactly the token's: **it survives a
 * relog and it does not survive a resource restart**, because tokens are reissued from an
 * in-memory table. Surviving a relog is the case that matters, since that is the whole of
 * mute evasion; surviving an `ensure gphone` is a nicety, and the price of it would be a
 * stored cross-session identifier for every player who has ever pressed play.
 */

const sanitizeLabel = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/\s+/g, ' ').trim().slice(0, 48);
  return trimmed || null;
};

/**
 * Narrow one roster row, or drop it.
 *
 * Every field here was chosen by something outside the phone, and one of them ends up
 * interpolated into an `<iframe src>`, so the ids are held to `shared/youtube.ts`'s own
 * shapes exactly as a pasted link is. A row that fails is dropped rather than repaired:
 * there is no sensible half of "somebody is playing something".
 */
const sanitizeBroadcast = (raw: unknown): NearbyBroadcast | null => {
  if (typeof raw !== 'object' || raw === null) return null;
  const row = raw as Record<string, unknown>;

  const token = typeof row.token === 'string' ? row.token.trim().slice(0, 64) : '';
  // No token, no audio, and never a fallback to the source — `client/services/Music.ts`
  // refuses the same row for the same reason. Falling back would produce a phone that
  // plays perfectly and forgets every mute on reconnect: mute evasion arriving as a
  // feature nobody would notice was broken for weeks.
  if (!token) return null;

  const source =
    typeof row.source === 'number' && Number.isInteger(row.source) && row.source > 0
      ? row.source
      : 0;

  const videoId = typeof row.videoId === 'string' && isVideoId(row.videoId) ? row.videoId : null;
  const playlistId =
    typeof row.playlistId === 'string' && isPlaylistId(row.playlistId) ? row.playlistId : null;
  if (!videoId && !playlistId) return null;

  const startedAt =
    typeof row.startedAt === 'number' && Number.isFinite(row.startedAt) ? row.startedAt : 0;

  return {
    source,
    token,
    label: sanitizeLabel(row.label),
    videoId,
    playlistId,
    startedAt,
    paused: row.paused === true
  };
};

/**
 * A mute list off storage, bounded.
 *
 * Runs on the value read at startup **and on every write**, so it is idempotent as well as
 * strict. The cap is a bound on what a restart can be made to carry rather than an opinion
 * about how many people one person may mute — and tokens are reissued when the resource
 * restarts, so a list that grew forever would be a list of keys that mean nothing.
 */
const sanitizeMutedTokens = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    const token = raw.trim().slice(0, 64);
    if (token) seen.add(token);
    if (seen.size >= 200) break;
  }
  return [...seen];
};

const rosterStore: Writable<NearbyBroadcast[]> = writable([]);
/**
 * The game client's attenuation, keyed by **`source`** and not by token.
 *
 * The one place the two identities are not interchangeable, and it is not an inconsistency:
 * the world half computes a distance to a ped it found with `GetPlayerFromServerId`, so a
 * server id is the only key it has. The join happens here, on the roster row that carries
 * both.
 */
const volumeStore: Writable<Record<string, number>> = writable({});
const audibleStore: Writable<AudibleBroadcast[]> = writable([]);

/**
 * People this phone will not play, by broadcaster token.
 *
 * Persisted and character-synced, unlike the queue in `state/music.ts` — a queue is content
 * and a mute is a preference, and this one is the preference that matters most to get
 * right across a reconnect: the person you muted last night is the person you are standing
 * next to this morning.
 */
const mutedStore = usePersisted<string[]>('settings', 'musicMutedBroadcasters', [], {
  sanitize: sanitizeMutedTokens
});

/**
 * The switch for when you do not care who it is.
 *
 * Kept as its own flag rather than "mute everyone currently nearby", which is what it
 * would have to be if it were expressed through the list above — and that version silences
 * the four people in earshot now and none of the four who walk up next, which is not what
 * anybody reaching for it means. It is a standing statement, and it is the one somebody
 * being harassed can hit without first working out whose music it is.
 *
 */
const muteAllStore = usePersisted<boolean>('settings', 'musicMuteNearby', false, {
  sanitize: (value) => value === true
});

/**
 * Where each broadcast joined, cached by source identity.
 *
 * **The reason this cache exists is frame churn.** The offset is `now - startedAt`, so
 * recomputing it on every recompute would move it every time the game client pushed a
 * volume — several times a second — and the offset is part of the embed URL, which is what
 * `MusicFrame` keys its iframe on. A fresh number per tick is a fresh YouTube player per
 * tick. So it is computed once per `(videoId, playlistId, startedAt)` and kept until that
 * tuple changes, which is exactly when the broadcaster has genuinely started something
 * else and a re-join is correct.
 *
 * A pause is the interesting case, and the server has already answered it:
 * `NearbyBroadcast.startedAt` is recomputed at send time for a paused broadcast so that
 * `now - startedAt` is the frozen position. So resuming moves `startedAt`, which changes
 * the signature, which rebuilds the frame at the right offset by the ordinary route. If
 * that recompute ever goes away, a resumed broadcast drifts by the length of the pause on
 * every listener — and the phone cannot detect it, because it was never told there was a
 * pause to account for.
 */
const offsets = new Map<string, { sig: string; startAt: number }>();

/** Who is audible right now, so the ranking can prefer them — see `INCUMBENT_MARGIN`. */
let incumbents = new Set<string>();

/**
 * Everybody who was unmuted and in earshot last time.
 *
 * Compared rather than remembered for its own sake: while this set is unchanged, movement
 * in the volumes is distance and incumbency holds; the moment it changes, something was
 * decided — a mute, an unmute, an arrival, a departure — and the selection is made again
 * with no bonus for anybody. See `recompute`.
 */
let eligible = new Set<string>();

const sigOf = (b: NearbyBroadcast): string =>
  `${b.videoId ?? ''}|${b.playlistId ?? ''}|${b.startedAt}`;

/**
 * Where a broadcast should start, in seconds.
 *
 * **Only a video gets an offset.** A playlist row is a list the embed advances by itself,
 * and `startedAt` refers to when the *list* started, not to the track inside it that the
 * broadcaster is on — so seeking a playlist to `now - startedAt` would land in the middle
 * of its first song rather than wherever they actually are. Starting a playlist from the
 * top is a visible desync and an honest one; the alternative is a wrong number that looks
 * right. A link carrying both a video and a list is offset on the video, which is the
 * entry point the broadcaster is actually on.
 */
const startAtFor = (b: NearbyBroadcast, now: number): number => {
  const sig = sigOf(b);
  const cached = offsets.get(b.token);
  if (cached && cached.sig === sig) return cached.startAt;
  const startAt = b.videoId ? joinOffsetSeconds(b.startedAt, now) : 0;
  offsets.set(b.token, { sig, startAt });
  return startAt;
};

/** By `source`, because that is the key the game client can produce. See `volumeStore`. */
const volumeFor = (volumes: Record<string, number>, source: number): number => {
  const raw = volumes[String(source)];
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0;
  return Math.max(0, Math.min(1, raw));
};

const sameAudible = (a: AudibleBroadcast[], b: AudibleBroadcast[]): boolean =>
  a.length === b.length &&
  a.every((x, i) => {
    const y = b[i];
    return (
      x.token === y.token &&
      x.videoId === y.videoId &&
      x.playlistId === y.playlistId &&
      x.startAt === y.startAt &&
      x.paused === y.paused &&
      x.label === y.label &&
      x.attenuation === y.attenuation
    );
  });

/**
 * Decide what is playing, and write it once.
 *
 * ## Mute is applied before the cap, never after
 *
 * A muted broadcaster is not a loser of the ranking, it is not *in* the ranking — so
 * muting the person nearest you promotes the next one into the slot they were holding. The
 * other order is the bug this is written to avoid: a mute that leaves a silent hole reads
 * as "mute broke the music", because the person hears one fewer stereo and no new one,
 * which is the opposite of what they asked for.
 *
 * That is also why the selection happens here rather than on the game client. The client
 * ranks and attenuates the whole roster, nearest first, and stops there. It cannot cap,
 * because **the mute list lives on this side** and a client that trimmed to three before
 * the shell saw them would hand over slots already spent on people this phone refuses to
 * play. The server's `DEFAULT_MAX_NEARBY` is a bound on how much crosses the wire, not a
 * ceiling on what is audible; `MAX_AUDIBLE_BROADCASTS` is the only cap that decides
 * anything.
 *
 * ## When hysteresis applies, and when it must not
 *
 * `INCUMBENT_MARGIN` exists to damp *continuous* jitter: two people walking near each
 * other produce distances that cross and re-cross several times a second, and each
 * crossing would otherwise be an iframe destroyed and a YouTube player created.
 *
 * It must not survive a **discrete** change, and the sharp case is an unmute. Somebody
 * unmuted who is genuinely nearer than a currently-playing source has to displace them —
 * the stated winner rule is nearest wins, and an unmute that quietly lost to a 0.05 bonus
 * reads as the unmute not having worked.
 *
 * So the two are told apart by **who is eligible**, not by which store fired. The eligible
 * set is everybody unmuted and in earshot; while it is unchanged, any movement in the
 * numbers is distance and incumbency holds, and the moment it changes the whole selection
 * is made again from scratch with no bonus for anybody.
 *
 * Deriving that here rather than taking a `fresh` flag from each caller is deliberate.
 * The flag version has to be right at four call sites and was already wrong at one of
 * them: a broadcaster who walks up arrives on the *roster* push and only becomes a
 * candidate on the *volume* push a tick later, so "a roster change is discrete" flagged
 * the message that could not act on it and missed the one that could. Comparing the set
 * cannot make that mistake, and it also picks up the case nobody listed — a broadcast
 * fading out of earshot frees a slot, which should be filled on the rule.
 *
 * ## Eviction is total, re-entry is a fresh join
 *
 * Losing the cap unmounts the player and nothing about it is remembered except the offset
 * cache, which is keyed on a signature that has usually moved on by the time it matters. A
 * broadcaster who wins the cap back restarts at `now - startedAt` — joining live, which is
 * the only thing a broadcast can honestly do. Resuming where it was evicted would be
 * replaying a stranger's past.
 *
 * The write is guarded on the result actually differing. The game client pushes volumes on
 * a tick and most ticks change nothing a player element cares about, and every write here
 * is an `{#each}` re-render on a component whose children are cross-origin video players.
 */
function recompute(): void {
  if (get(muteAllStore)) {
    incumbents = new Set();
    eligible = new Set();
    if (get(audibleStore).length) audibleStore.set([]);
    return;
  }

  const muted = new Set(get(mutedStore));
  const volumes = get(volumeStore);
  const now = Date.now();

  const candidates = get(rosterStore).filter(
    (b) => !muted.has(b.token) && volumeFor(volumes, b.source) > 0
  );
  const nowEligible = new Set(candidates.map((b) => b.token));
  const changed = !sameKeys(eligible, nowEligible);
  eligible = nowEligible;

  const winners = rankAudible(
    candidates,
    (b) => volumeFor(volumes, b.source),
    changed ? NO_INCUMBENTS : incumbents,
    MAX_AUDIBLE_BROADCASTS
  );

  const next = winners.map((b) => ({
    ...b,
    attenuation: volumeFor(volumes, b.source),
    startAt: startAtFor(b, now)
  }));

  incumbents = new Set(next.map((b) => b.token));
  if (!sameAudible(get(audibleStore), next)) audibleStore.set(next);
}

/** Shared empty set, so a fresh selection allocates nothing on a hot path. */
const NO_INCUMBENTS: ReadonlySet<string> = new Set<string>();

const sameKeys = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean =>
  a.size === b.size && [...a].every((key) => b.has(key));

/**
 * The server's roster, replacing whatever was here.
 *
 * A snapshot rather than a delta, which is what makes "they walked away" expressible at
 * all: a delta protocol needs a removal message that can be lost, and a lost removal is
 * music that never stops. An empty list means nobody is nearby, and it is the ordinary way
 * this ends.
 */
export function receiveNearbyBroadcasts(list: readonly unknown[]): void {
  const seen = new Set<string>();
  const rows: NearbyBroadcast[] = [];
  for (const raw of list.slice(0, MAX_NEARBY_BROADCASTS)) {
    const row = sanitizeBroadcast(raw);
    // First mention of a token wins, so a duplicated row cannot occupy two slots of the
    // cap. The bound above is the server's own, restated here because a registered event
    // is reachable regardless of what the server chose to send (AGENTS.md §2.9).
    if (!row || seen.has(row.token)) continue;
    seen.add(row.token);
    rows.push(row);
  }

  // Nobody keeps a join offset for a broadcast that is over. Left to grow, this map would
  // be the one thing in the module that never shrinks on a busy server.
  for (const token of [...offsets.keys()]) if (!seen.has(token)) offsets.delete(token);

  rosterStore.set(rows);
  recompute();
}

/**
 * The game client's attenuation per broadcaster, replacing whatever was here.
 *
 * Also a snapshot: an id the client stopped mentioning is out of earshot, and treating a
 * missing entry as "unchanged" would leave a player audible after they had walked away.
 * An unknown id is kept rather than dropped — the two messages race, and a volume that
 * arrives a tick before the roster naming it should not have to be sent twice.
 */
export function receiveNearbyVolumes(volumes: Record<string, unknown>): void {
  const next: Record<string, number> = {};
  for (const [key, raw] of Object.entries(volumes)) {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
    // Keyed by `source`, which the game client sends as a string. Anything that is not a
    // server id is dropped rather than kept under a key no roster row can ever match.
    const source = Number(key);
    if (!Number.isInteger(source) || source <= 0) continue;
    next[String(source)] = Math.max(0, Math.min(1, raw));
  }
  volumeStore.set(next);
  recompute();
}

/** Everyone the server says is playing something nearby, muted ones included. */
export const nearbyBroadcasts: Readable<NearbyBroadcast[]> = { subscribe: rosterStore.subscribe };

/**
 * The ones actually making noise: not muted, in earshot, and inside the cap.
 *
 * `NearbyMusicPlayer.svelte` renders exactly this list and nothing else, so a broadcast
 * leaving it is a frame torn down and a broadcast joining it is a frame created.
 */
export const audibleBroadcasts: Readable<AudibleBroadcast[]> = {
  subscribe: audibleStore.subscribe
};

/** Broadcaster tokens this phone refuses to play. */
export const mutedBroadcasters: Readable<string[]> = { subscribe: mutedStore.subscribe };

/** Whether every nearby broadcast is silenced, whoever it belongs to. */
export const muteAllNearby: Readable<boolean> = { subscribe: muteAllStore.subscribe };

/** How many people nearby are playing something, muted ones included. */
export const nearbyBroadcastCount: Readable<number> = derived(rosterStore, (rows) => rows.length);

export function muteBroadcaster(token: string): void {
  if (!token) return;
  mutedStore.update((tokens) => (tokens.includes(token) ? tokens : [...tokens, token]));
}

export function unmuteBroadcaster(token: string): void {
  mutedStore.update((tokens) => tokens.filter((existing) => existing !== token));
}

export function toggleBroadcasterMute(token: string): void {
  if (get(mutedStore).includes(token)) unmuteBroadcaster(token);
  else muteBroadcaster(token);
}

/** Forget every individual mute. Does not touch `muteAllNearby`, which is its own switch. */
export function clearMutedBroadcasters(): void {
  mutedStore.set([]);
}

export function setMuteAllNearby(on: boolean): void {
  muteAllStore.set(on === true);
}

export function toggleMuteAllNearby(): void {
  muteAllStore.update((on) => !on);
}

/**
 * A mute is a preference and can change without going through the setters above —
 * `rehydrateSettings` replaces the whole store when the server answers, and an add-on may
 * hold the same writable. Subscribing is what makes the audible list follow it either way.
 *
 * Module scope, on a page CEF never unloads, so this is for the session. It fires once on
 * subscribe, which is also the initial `recompute` and is why there is no separate one.
 */
derived([mutedStore, muteAllStore], (values) => values).subscribe(() => recompute());

/** @internal Test-only: put the module back to a fresh page's state. */
export function resetNearbyMusicForTest(): void {
  rosterStore.set([]);
  volumeStore.set({});
  audibleStore.set([]);
  mutedStore.set([]);
  muteAllStore.set(false);
  offsets.clear();
  incumbents = new Set();
}
