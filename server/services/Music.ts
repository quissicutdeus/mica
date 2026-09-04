// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// The server half of the music service: who is playing out loud, and who can hear it.
import { PlayerFacingError } from '../lib/errors';
import { ServiceEndpoint } from '../lib/ServiceEndpoint';
import { musicContract } from '@mica/shared/contracts/music';
import { FrameworkBridge } from '../lib/FrameworkBridge';
import { playerCoords } from '../lib/playerCoords';
import { isPlaylistId, isVideoId, parseYouTubeSource } from '@mica/shared/youtube';
import {
  DEFAULT_MAX_NEARBY,
  DEFAULT_MUSIC_RANGE,
  MAX_NEARBY_BROADCASTS,
  MUSIC_BROADCAST_NET_EVENT,
  type NearbyBroadcast,
  type NearbyMusicEnvelope
} from '@mica/shared/musicBroadcast';

/**
 * MICA-111 phase 2 — the half that makes a phone audible to the people standing next to
 * it. Phases 1 and 3 built a player and a queue that lived entirely in one client.
 *
 * ## Ephemeral, in memory, and gone on a restart
 *
 * There is no table here and no `defineService`, for the reason `Signal.ts` gives about
 * its dead zones: what is held is a fact about *this* session, not about a character. A
 * broadcast is somebody's phone making noise right now; it belongs to the connection that
 * started it and to nothing else. The queue it is playing from is client-side and already
 * persisted there (`web/src/shell/state/music.ts`), so a table would carry a migration and
 * buy nothing but the ability to resurrect a stereo nobody is standing next to.
 *
 * **So the answer to "does this survive `ensure mica`" is no, deliberately.** A restart
 * clears every broadcast, the CEF page reloads with it, and every client comes back
 * silent. That is the correct end state rather than a limitation: the alternative is a
 * server that remembers a track a player has long since stopped.
 *
 * ## Why the fan-out is a poll and not a push at start/stop
 *
 * Range is a function of where two people are standing, which changes when neither of them
 * touches their phone. A push at start and stop would mean walking *into* earshot of a
 * stereo you never hear, and walking out of it while it plays forever. So this polls,
 * exactly as `Signal.ts` does, and for the same reason: the state that decides the answer
 * is the world's, not the phone's.
 *
 * It is affordable for the same reason too — the early-out. With nobody broadcasting there
 * is nothing a position could change, so the ordinary case reads no coordinates at all.
 * The cost only appears while somebody is actually playing something out loud, and it is
 * one `GetEntityCoords` per connected player per tick, bounded further by pushing only
 * when a listener's audible *set* changes rather than every tick.
 *
 * ## What the server does not decide
 *
 * Volume and muting. Attenuation needs the listener's own position, which only the
 * listener has; a mute is a preference rather than a disclosure boundary — the same call
 * MICA-63 made for notification sounds — and a modified client ignoring one gains
 * nothing it could not already get by standing there. Keeping both client-side also keeps
 * a per-recipient settings read out of a fan-out that runs on a timer.
 */

/** No table: this service is signalling, so every generic CRUD action is off. */
const app = new ServiceEndpoint<never, typeof musicContract>('music', null, {
  contract: musicContract,
  disableGet: true,
  disableCreate: true,
  disableUpdate: true,
  disableDelete: true
});

interface Broadcast {
  /** The broadcaster's server id. Keyed on it — see `broadcasts` below. */
  source: number;
  /** Never leaves the server. It is what `tokenFor` keys the wire identity on. */
  citizenid: string;
  videoId: string | null;
  playlistId: string | null;
  /**
   * The wall-clock instant the track's 0:00 maps to. `now - startedAt` is the position,
   * which is the whole of the sync design: one number, no clock exchange, and drift over a
   * track that nobody is listening to on headphones is not worth a protocol.
   */
  startedAt: number;
  /** When it was paused, or null. A paused broadcast holds its position. */
  pausedAt: number | null;
}

/**
 * Who is broadcasting, keyed by **source**.
 *
 * Source rather than citizenid, matching `Signal.ts`'s overrides: this is inherently live
 * — it means nothing for a player who is not connected — and it is what a listener's
 * client needs anyway to find the broadcaster in the world. FiveM reuses server ids, which
 * is exactly why `playerDropped` clears the entry rather than letting the next player
 * inherit a stereo.
 */
const broadcasts = new Map<number, Broadcast>();

/**
 * The last audible set pushed to each listener, as a signature.
 *
 * Without it every listener would be told the same thing every two seconds forever. With
 * it, a push happens when what you can hear actually changes — somebody starts, stops,
 * skips, pauses, or walks in or out of earshot.
 */
const lastPushed = new Map<number, string>();

/**
 * The opaque handle each character is known by on the wire, and the one place a citizenid
 * turns into something safe to send.
 *
 * The shell keys a persisted mute on what it is given, which rules out both cheap answers.
 * A **server id** is void the moment its target relogs — precisely the person a mute exists
 * for — and, being reused, would eventually silence an innocent player who inherited the
 * slot. A **citizenid** would work and is not ours to hand out: `defineService`'s public
 * projection strips it automatically, and that is a repo-wide stance rather than an
 * accident, so putting it in front of every nearby client for the convenience of a mute list
 * would be exactly the correlation handle that stance exists to withhold.
 *
 * So: a random token, looked up rather than derived. **Not a hash of the citizenid** — a
 * constant salt in an open-source repo is not a salt, and a token anyone can recompute from
 * a citizenid they already have is not opaque. There is nothing in this string to reverse.
 *
 * It is not a secret either, and nothing is authorised by holding one: it is a name for
 * somebody's stereo, and the only thing a listener can do with it is refuse to play it.
 *
 * Never cleared on disconnect — surviving one is the entire point. It is cleared by a
 * resource restart, which is the documented limit: a mute survives a relog, not an
 * `ensure mica`. One short string per character who has ever pressed play.
 */
const tokens = new Map<string, string>();

let tokenCounter = 0;

const issueToken = (): string => {
  tokenCounter += 1;
  // No `crypto` on the FiveM server runtime worth relying on, and none needed: this has to
  // be unguessable-adjacent and unique, not cryptographic. The counter is what guarantees
  // two characters can never collide however `Math.random` behaves.
  const noise = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
  return `${noise}${tokenCounter.toString(36)}`;
};

const tokenFor = (citizenid: string): string => {
  const existing = tokens.get(citizenid);
  if (existing) return existing;
  const issued = issueToken();
  tokens.set(citizenid, issued);
  return issued;
};

/** Test seam, matching `__resetSignal` and `__resetCalls`: module state that would leak. */
export const __resetMusic = (): void => {
  broadcasts.clear();
  lastPushed.clear();
  tokens.clear();
};

/** Read-only view of the live state, for tests and for `micamusic`-style diagnostics. */
export const activeBroadcasts = (): Broadcast[] => [...broadcasts.values()];

const POLL_MS = 2000;

/**
 * How much a re-announced position has to differ before it counts as a seek.
 *
 * A client that re-sends its position — on resume, on a resync, on the next track's start
 * arriving a beat late — must not yank every listener back by the network latency it took
 * to say so. Anything inside this window keeps the `startedAt` already agreed; anything
 * outside it is a real seek and everybody moves.
 */
const RESYNC_TOLERANCE_MS = 2000;

/** A track nobody could plausibly be this far into. Bounds a client-supplied position. */
const MAX_POSITION_MS = 12 * 60 * 60 * 1000;

const rangeMeters = (): number =>
  typeof GetConvarInt === 'function'
    ? GetConvarInt('mica_music_range', DEFAULT_MUSIC_RANGE)
    : DEFAULT_MUSIC_RANGE;

/**
 * How many broadcasters a listener's roster may name, clamped to `MAX_NEARBY_BROADCASTS`.
 *
 * The *roster* cap, not the audible one. What actually plays is the client's decision —
 * `web/src/lib/musicBroadcast.ts` ranks by its own attenuation and keeps the loudest few
 * with a margin so two neighbours cannot swap slots on every distance tick — because only
 * the client knows those distances. What the server owes it is a bounded list, nearest
 * first, so anything dropped is what was least likely to be heard anyway. The convar is a
 * dial rather than a licence: a server owner who sets it to 40 gets the ceiling.
 */
const maxNearby = (): number => {
  const raw =
    typeof GetConvarInt === 'function'
      ? GetConvarInt('mica_music_max_nearby', DEFAULT_MAX_NEARBY)
      : DEFAULT_MAX_NEARBY;
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_MAX_NEARBY;
  return Math.min(Math.trunc(raw), MAX_NEARBY_BROADCASTS);
};

/**
 * What the client says it is playing, reduced to ids or refused.
 *
 * Accepts a pasted link as well as ids, because §2.9 makes this a boundary and not a
 * convenience: a registered net event is reachable whatever the UI does, so the ids the
 * app already parsed are re-derived here through the one parser both sides share
 * (`shared/youtube.ts`). Nothing that is not an id from that alphabet can get past this
 * line, which is what makes interpolating one into an embed URL safe later.
 */
const sourceFrom = (
  body: Record<string, unknown>
): { videoId: string | null; playlistId: string | null } | null => {
  const url = body.url ?? body.source;
  if (typeof url === 'string' && url.trim()) return parseYouTubeSource(url);

  const videoId = typeof body.videoId === 'string' && isVideoId(body.videoId) ? body.videoId : null;
  const playlistId =
    typeof body.playlistId === 'string' && isPlaylistId(body.playlistId) ? body.playlistId : null;
  if (!videoId && !playlistId) return null;
  return { videoId, playlistId };
};

/**
 * A position off the wire, bounded, or 0.
 *
 * Client-authoritative, and deliberately: only the broadcaster's own player knows where it
 * is in the track, and the worst a lying client achieves is desynchronising the listeners
 * of its own music. It is bounded anyway, because an unbounded number here becomes a
 * `startedAt` far enough in the past or the future to be arithmetic nobody planned for.
 */
const positionFrom = (raw: unknown): number => {
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN;
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.trunc(value), MAX_POSITION_MS);
};

/** Where the broadcast is right now, in ms. Frozen while paused. */
const positionOf = (b: Broadcast, now: number): number =>
  Math.max(0, (b.pausedAt ?? now) - b.startedAt);

/**
 * The anchor a seek is compared against: what `startedAt` would be if the current position
 * were re-announced this instant. For a paused broadcast that is not `startedAt` itself.
 */
const positionAnchor = (b: Broadcast, now: number): number => now - positionOf(b, now);

/**
 * Start — or replace — what this player is broadcasting.
 *
 * Replacing rather than refusing a second start is what a queue advancing to the next
 * track looks like from here, so there is no separate "next" action and no way for the
 * server's idea of the current track to lag the client's by one.
 */
app.registerEvent('broadcastStart', async (source, _cbId, data, citizenid) => {
  const body = data;
  const parsed = sourceFrom(body);
  if (!parsed)
    throw new PlayerFacingError('That is not a YouTube link.', {
      key: 'server.music.notYouTube'
    });

  const now = Date.now();
  const startedAt = now - positionFrom(body.positionMs);
  const existing = broadcasts.get(source);

  const sameTrack =
    existing &&
    existing.videoId === parsed.videoId &&
    existing.playlistId === parsed.playlistId &&
    existing.pausedAt === null &&
    Math.abs(startedAt - existing.startedAt) < RESYNC_TOLERANCE_MS;

  broadcasts.set(source, {
    source,
    citizenid,
    videoId: parsed.videoId,
    playlistId: parsed.playlistId,
    startedAt: sameTrack ? existing!.startedAt : startedAt,
    pausedAt: null
  });

  // Now rather than on the next tick, for the reason `setPlayerSignal` gives: two seconds
  // of silence after pressing play reads as the feature having failed.
  pollMusic();
  return { ok: true };
});

/**
 * Pause, resume, or seek an existing broadcast.
 *
 * Silently does nothing for a player who is not broadcasting — there is no state to
 * describe and nothing a caller could usefully do about it, which is the same shape
 * `Phone.ts` uses for an `end` on a call that is already over.
 */
app.registerEvent('broadcastUpdate', async (source, _cbId, data) => {
  const current = broadcasts.get(source);
  if (!current) return { ok: false, reason: 'not_broadcasting' as const };

  const body = data;
  const now = Date.now();
  const next: Broadcast = { ...current };

  if (body.positionMs !== undefined) {
    const startedAt = now - positionFrom(body.positionMs);
    // Same tolerance as `broadcastStart`: a routine position report is not a seek.
    if (Math.abs(startedAt - positionAnchor(current, now)) >= RESYNC_TOLERANCE_MS) {
      next.startedAt = startedAt;
      if (next.pausedAt !== null) next.pausedAt = now;
    }
  }

  if (typeof body.paused === 'boolean') {
    if (body.paused && next.pausedAt === null) {
      next.pausedAt = now;
    } else if (!body.paused && next.pausedAt !== null) {
      // Resume where it stopped, not where it would have been had it kept playing.
      next.startedAt = now - (next.pausedAt - next.startedAt);
      next.pausedAt = null;
    }
  }

  broadcasts.set(source, next);
  pollMusic();
  return { ok: true };
});

/** Stop broadcasting. Idempotent — stopping twice is not an error worth an exception. */
app.registerEvent('broadcastStop', async (source) => {
  const stopped = broadcasts.delete(source);
  if (stopped) pollMusic();
  return { ok: true };
});

/** `Firstname Lastname` off the framework's in-memory character, or null. */
const labelFor = (player: unknown): string | null => {
  const charinfo = (player as { PlayerData?: { charinfo?: Record<string, unknown> } })?.PlayerData
    ?.charinfo;
  if (!charinfo) return null;
  const first = typeof charinfo.firstname === 'string' ? charinfo.firstname : '';
  const last = typeof charinfo.lastname === 'string' ? charinfo.lastname : '';
  const name = `${first} ${last}`.trim();
  return name ? name.slice(0, 64) : null;
};

/**
 * Is this source still a live client?
 *
 * The same check `Signal.ts` makes before `emitNet`, and here it does double duty: a
 * broadcaster the server can no longer name has gone, whether or not `playerDropped` was
 * seen. That is the backstop against the failure mode that matters most — a phantom stereo
 * playing forever for everybody standing where somebody used to be.
 */
const isLive = (src: number): boolean =>
  typeof GetPlayerName !== 'function' || Boolean(GetPlayerName(String(src)));

const send = (src: number, envelope: NearbyMusicEnvelope): boolean => {
  if (typeof emitNet !== 'function') return false;
  try {
    emitNet(MUSIC_BROADCAST_NET_EVENT, src, envelope);
    return true;
  } catch (error) {
    console.error(`[mica] music push to ${src} failed:`, error);
    return false;
  }
};

/**
 * One tick: work out what everybody can hear, and tell the ones for whom it changed.
 *
 * Exported as a test seam, the way `pollSignal` is — a fan-out that could only be observed
 * by waiting out a two-second interval is a fan-out nobody writes a test for.
 */
export const pollMusic = (): void => {
  const now = Date.now();

  // A broadcaster who has gone takes their broadcast with them, before anything is sent.
  // Deleting the current key mid-iteration is defined behaviour for a Map, so this walks
  // the live keys rather than a copy of them.
  for (const src of broadcasts.keys()) {
    if (!isLive(src)) broadcasts.delete(src);
  }

  const active = [...broadcasts.values()];

  /**
   * The early-out. With nobody playing anything there is no coordinate worth reading —
   * but anyone who *was* hearing something still has to be told it stopped, exactly once.
   */
  if (active.length === 0) {
    for (const src of lastPushed.keys()) {
      if (isLive(src)) send(src, { at: now, broadcasters: [] });
      lastPushed.delete(src);
    }
    return;
  }

  const players = FrameworkBridge.getAllPlayers();

  const located: {
    broadcast: Broadcast;
    coords: [number, number, number];
    label: string | null;
  }[] = [];
  for (const broadcast of active) {
    const coords = playerCoords(broadcast.source);
    // No ped — spawning, or between characters. Inaudible this tick, but still theirs: a
    // player walking back into the world should not have to press play again.
    if (!coords) continue;
    located.push({ broadcast, coords, label: labelFor(players[String(broadcast.source)]) });
  }

  const range = rangeMeters();
  const rangeSquared = range * range;
  const cap = maxNearby();

  for (const key of Object.keys(players)) {
    const listener = Number(key);
    if (!Number.isFinite(listener)) continue;

    const listenerCoords = playerCoords(listener);

    const audible = listenerCoords
      ? located
          .filter(({ broadcast }) => broadcast.source !== listener)
          .map((entry) => {
            const dx = entry.coords[0] - listenerCoords[0];
            const dy = entry.coords[1] - listenerCoords[1];
            const dz = entry.coords[2] - listenerCoords[2];
            return { entry, distanceSquared: dx * dx + dy * dy + dz * dz };
          })
          .filter(({ distanceSquared }) => distanceSquared <= rangeSquared)
          // Nearest wins, stated here rather than emerging from iteration order — the cap
          // has to be a rule somebody can read, because it decides what a player hears.
          .sort((a, b) => a.distanceSquared - b.distanceSquared)
          .slice(0, cap)
          .map(({ entry }) => entry)
      : [];

    /**
     * Signature over the *set*, and over the stored state rather than the payload.
     *
     * The wire's `startedAt` is recomputed at send time for a paused broadcast, so a
     * signature taken from the payload would be unique every tick and the dedupe would
     * be a no-op. Sorted by source so a mere change of who is closer — which the
     * listener's own attenuation already handles — does not spend a message.
     *
     * `.sort()` rather than `.toSorted()`: the array `.map()` just produced is nobody
     * else's, so there is nothing to protect by copying it, and `.toSorted()` is not in
     * the `es2021` lib `server/tsconfig.json` compiles against.
     */
    const signature = audible
      .map(
        ({ broadcast }) =>
          `${broadcast.source}:${broadcast.videoId ?? ''}:${broadcast.playlistId ?? ''}:` +
          `${broadcast.startedAt}:${broadcast.pausedAt === null ? 'p' : 's'}`
      )
      .sort()
      .join('|');

    const previous = lastPushed.get(listener);
    if (previous === signature) continue;
    // Never heard anything and still hearing nothing: nothing to say.
    if (previous === undefined && signature === '') continue;

    if (!isLive(listener)) continue;

    const payload: NearbyBroadcast[] = audible.map(({ broadcast, label }) => ({
      source: broadcast.source,
      // Issued here rather than at start, so the lookup is touched only for a broadcast
      // somebody can actually hear.
      token: tokenFor(broadcast.citizenid),
      label,
      videoId: broadcast.videoId,
      playlistId: broadcast.playlistId,
      /**
       * The anchor rather than the stored `startedAt`, and they differ only while paused.
       * A paused broadcast has to answer "where is it stopped", and `now - startedAt` would
       * keep growing while nothing plays — so a listener joining a paused stereo would seek
       * to a position it never reached. `positionAnchor` freezes it at send time.
       */
      startedAt: positionAnchor(broadcast, now),
      paused: broadcast.pausedAt !== null
    }));

    // Marked only once the send actually goes out, matching `Signal.ts`: marking it first
    // would tell the next tick "already told them" about a message that never left.
    if (send(listener, { at: now, broadcasters: payload })) {
      if (signature === '') lastPushed.delete(listener);
      else lastPushed.set(listener, signature);
    }
  }
};

if (typeof setInterval === 'function') setInterval(pollMusic, POLL_MS);

on('playerDropped', () => {
  const src = source;
  const wasBroadcasting = broadcasts.delete(src);
  lastPushed.delete(src);
  // Immediately, not on the next tick: the whole point is that a disconnect never leaves a
  // stereo playing for everyone standing where its owner used to be.
  if (wasBroadcasting) pollMusic();
});
