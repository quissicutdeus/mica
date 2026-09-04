// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { DEFAULT_MUSIC_RANGE } from '@mica/shared/musicBroadcast';

/**
 * How loud a neighbour's phone is, from where this ped is standing. MICA-111 phase 2.
 *
 * `shared/musicBroadcast.ts` puts it plainly: the envelope carries no volume, because only
 * the client knows where it is. That leaves exactly one job here, and it is a world-state
 * job rather than a phone one — which is why it sits in `client/game/` beside the camera
 * and the freelook rather than in `client/services/`. `client/services/Music.ts` owns the
 * roster and the NUI hop; this owns the tick, the distance and the curve.
 *
 * What it produces is an **attenuation, not a decision**. The listener's own music volume,
 * per-broadcaster mute and the global "mute all nearby music" are shell state, and are
 * free to multiply this by zero. Nothing here knows whether they did.
 *
 * ## The curve
 *
 * Clamped quadratic: full volume inside {@link FULL_VOLUME_RADIUS}, exactly zero at the
 * range boundary, and `(1 - t)²` across the band between, where `t` is the fraction of the
 * way across it.
 *
 * Linear falloff is the obvious choice and it is wrong. Sound intensity falls as 1/d², so a
 * gain that falls linearly is *too loud too far away*: four fifths of the way to the
 * boundary it is still at 0.2, which is comfortably audible. That produces a wide outer
 * ring of faint, tinny music that follows the listener around — loud enough to notice,
 * too quiet to identify, and reported as more irritating than either hearing a track
 * properly or not hearing it at all.
 *
 * Squaring puts that same point at 0.04, below anything audible over an engine, while
 * keeping the near field loud: half way across the band is still 0.25 and the first few
 * metres barely move. Two alternatives were considered and rejected:
 *
 *   - **True inverse-distance** (`ref / (ref + d - ref)`, the Web Audio / OpenAL model) is
 *     the physically honest one, but it is asymptotic — it never reaches zero, so it needs
 *     a cutoff bolted on, and that cutoff is a step you can hear as a click on the frame
 *     you cross it. The quadratic arrives at zero on its own.
 *   - **A logarithmic (dB) curve** matches perception best but needs a floor to avoid
 *     `-Infinity` at the boundary, which puts the same step back.
 *
 * {@link musicAttenuation} is pure so the shape can be argued with in a test rather than
 * in game, which is the only other place it could be.
 *
 * ## Range, and the one way an owner gets it wrong
 *
 * `mica_music_range` — the same convar and the same {@link DEFAULT_MUSIC_RANGE} the
 * server fans out on, deliberately one number rather than two that can disagree. It is not
 * `mica_bluetooth_range`, which is a hand-to-hand 15m and means something else.
 *
 * **A client only sees replicated convars.** `set mica_music_range 40` in `server.cfg`
 * reaches the server's fan-out and not this, so the two disagree; `setr` reaches both. The
 * disagreement is deliberately survivable in the direction it actually happens: the
 * unreplicated case leaves the client's range *smaller* than the server's, so entries
 * beyond it are simply scored at zero and music has a shorter range than configured. The
 * opposite (a client range wider than the fan-out) is the one with an artifact — a
 * broadcast leaving the roster while still scoring above zero cuts rather than fades — and
 * a client cannot reach it by failing to read a convar, only by an owner setting a smaller
 * `setr` value than the `set` one. `docs/` should say `setr`; this says why.
 *
 * ## Distance is 3D, and occlusion is not modelled
 *
 * Height counts, so somebody three floors up is quieter. That is free and correct.
 *
 * A wall between you is **not** modelled, and that is a decision rather than an omission.
 * The only primitive script has is a shapetest ray per broadcaster per tick, and its answer
 * is binary — walking past a doorway, a pillar or a parked car flips it, so the volume
 * chatters unless it is smoothed over a window long enough that the wall does nothing for
 * the first second anyway. GTA's own ambient audio does model occlusion, but through the
 * map's baked audio-occlusion data, which script cannot read. So music passes through
 * walls, and the shape of a future fix is a capsule test sampled at a few Hz feeding the
 * existing {@link SMOOTHING_TAU_SECONDS} smoothing — never a per-frame boolean multiplied
 * straight into the gain.
 */

/** A hostile or fat-fingered convar cannot make the tick meaningless in either direction. */
const MIN_RANGE_METERS = 5;
const MAX_RANGE_METERS = 150;

/**
 * Metres of full volume around the broadcaster.
 *
 * Without it, standing beside somebody and standing an arm's length away are audibly
 * different, which reads as the sound wobbling rather than as distance.
 */
const FULL_VOLUME_RADIUS = 2;

/**
 * Seconds for the volume to close ~63% of the gap to its target.
 *
 * Volume is interpolated, never assigned. A tick that writes its computed value straight
 * out steps the volume once per push, and a stepping volume does not sound like distance —
 * it sounds like a fault. Long enough to ride out a frame hitch or a walk past a doorway,
 * short enough that sprinting past somebody still tracks.
 */
const SMOOTHING_TAU_SECONDS = 0.35;

/** Milliseconds. The tick is per-frame; the NUI push is not. See {@link maybePush}. */
const PUSH_INTERVAL_MS = 75;

/** Volume difference worth a message. 1% of full scale is below what anyone can hear. */
const PUSH_EPSILON = 0.01;

/** A fading entry is treated as silent, and dropped, at or below this. */
const SILENT_BELOW = 0.005;

/**
 * The volume a silent broadcaster must reach before it counts as audible again.
 *
 * A deadband, and it is the anti-thrash rule for *this* end of the pipeline. The shell
 * ranks by the volume this file produces and filters silence out before ranking, so a
 * volume that crosses zero is a broadcaster entering and leaving candidacy — and a change
 * of candidacy is not a re-render, it is an iframe destroyed and a YouTube player created.
 * Somebody loitering at the edge of range would otherwise do that several times a second.
 *
 * `web/src/lib/musicBroadcast.ts`'s `INCUMBENT_MARGIN` is the same idea one layer up, and
 * it cannot cover this case: it arbitrates between candidates, and a volume of zero is not
 * a candidate at all. So the zero boundary needs its own hysteresis, and it belongs here,
 * with the number that crosses it.
 *
 * Wide in metres, negligible in loudness. Against the quadratic curve a 30m range puts this
 * at about 27m, so the band is roughly 3m deep — and both ends of it are inaudible, which
 * is what makes a deadband this generous free.
 */
const AUDIBLE_ABOVE = 0.02;

/** How often the replicated convar is re-read, in ms. It can change mid-session. */
const RANGE_CACHE_MS = 5000;

/** One broadcaster, scored from where this client is standing. */
export interface MusicLevel {
  /** The broadcaster's server id — the same handle the envelope and the shell key on. */
  source: number;
  /** 0..1, before the listener's own volume and any mute. */
  volume: number;
  /** Metres, 3D. `null` when the broadcaster's ped is not streamed in on this client. */
  distance: number | null;
}

interface Entry {
  source: number;
  /** The interpolated value actually reported. */
  volume: number;
  /** Where {@link Entry.volume} is heading this frame. */
  target: number;
  distance: number | null;
  /**
   * Whether this entry has passed {@link AUDIBLE_ABOVE} and not yet fallen back to silence.
   *
   * The hysteresis latch. A new entry starts `false` and needs a real gain to switch on;
   * once on, it stays on all the way down to {@link SILENT_BELOW}.
   */
  audible: boolean;
  /** No longer in the roster: fading to zero, then dropped. */
  retiring: boolean;
}

/**
 * Volume at `distance` metres, given the `range` at which it reaches silence.
 *
 * Pure, and exported for the test rather than for callers — the tick is the only caller.
 */
export function musicAttenuation(distance: number, range: number): number {
  if (!Number.isFinite(distance) || distance < 0) return 0;
  if (!Number.isFinite(range) || range <= 0) return 0;
  if (distance >= range) return 0;
  // A range inside the flat near field degenerates to audible-or-not; there is no band
  // left to interpolate across.
  if (range <= FULL_VOLUME_RADIUS) return 1;
  if (distance <= FULL_VOLUME_RADIUS) return 1;

  const t = (distance - FULL_VOLUME_RADIUS) / (range - FULL_VOLUME_RADIUS);
  return (1 - t) * (1 - t);
}

/**
 * Nearest first, with anything unlocatable last.
 *
 * A broadcaster this client cannot see is not a near one — it is one we know nothing
 * about — so it sorts behind every ped we can actually measure, at any range. Ties break
 * on source so the order is stable between frames and the shell is not handed a list that
 * reshuffles under it.
 */
const byDistance = (a: MusicLevel, b: MusicLevel): number => {
  if (a.distance === null && b.distance === null) return a.source - b.source;
  if (a.distance === null) return 1;
  if (b.distance === null) return -1;
  if (a.distance !== b.distance) return a.distance - b.distance;
  return a.source - b.source;
};

/**
 * The tick.
 *
 * **It does not run when there is nothing to attenuate.** `setSources([])` clears it, and
 * a `setTick` that is never created costs nothing — a `while true` doing arithmetic for a
 * feature nobody within 20 metres is using is a framerate cost paid by every player on the
 * server, most of whom will never hear a note.
 *
 * How many broadcasters can be in here is not this file's decision: the server applies
 * `mica_music_max_audible` before it sends, and `parseNearbyMusicEnvelope` bounds it
 * again at `MAX_AUDIBLE_BROADCASTS`. A second cap here would be a second rule about the
 * same thing, and the one that lost would be invisible.
 */
export class MusicProximity {
  private static entries = new Map<number, Entry>();
  private static tick: number | null = null;
  private static listener: ((levels: MusicLevel[]) => void) | null = null;

  private static lastPushAt = 0;
  private static lastPushedIds = '';

  private static cachedRange = DEFAULT_MUSIC_RANGE;
  private static rangeReadAt = 0;

  /** The one subscriber is `client/services/Music.ts`, which owns the NUI push. */
  public static onUpdate(listener: (levels: MusicLevel[]) => void): void {
    MusicProximity.listener = listener;
  }

  /**
   * Replace the set of broadcasters being scored.
   *
   * Sources that disappear are not deleted outright — they are marked retiring and fade,
   * so a broadcaster pressing stop while you stand next to them does not cut off mid-bar.
   * A broadcaster you walked away from is already near silent by the time the server drops
   * them, because the client's range is never the larger of the two, so the fade costs
   * nothing in that case and covers the other.
   */
  public static setSources(sources: number[]): void {
    const wanted = new Set(sources.filter((s) => Number.isInteger(s) && s > 0));

    for (const entry of MusicProximity.entries.values()) {
      entry.retiring = !wanted.has(entry.source);
    }
    for (const source of wanted) {
      if (MusicProximity.entries.has(source)) continue;
      // New broadcasters start silent and rise, so one that appears mid-range — somebody
      // beside you pressing play — fades in instead of arriving at full volume.
      MusicProximity.entries.set(source, {
        source,
        volume: 0,
        target: 0,
        distance: null,
        audible: false,
        retiring: false
      });
    }

    if (MusicProximity.entries.size > 0) MusicProximity.start();
    else MusicProximity.stop();
  }

  /**
   * Metres at which music reaches silence.
   *
   * Cached, because a per-frame tick reads it and `GetConvarInt` is a native call;
   * re-read periodically, because a replicated convar can change while the session runs
   * and a value read once at boot would outlive the change for the rest of it.
   */
  private static range(): number {
    const now = MusicProximity.gameTimer();
    if (MusicProximity.rangeReadAt !== 0 && now - MusicProximity.rangeReadAt < RANGE_CACHE_MS) {
      return MusicProximity.cachedRange;
    }
    MusicProximity.rangeReadAt = now || 1;

    const raw =
      typeof GetConvarInt === 'function'
        ? GetConvarInt('mica_music_range', DEFAULT_MUSIC_RANGE)
        : DEFAULT_MUSIC_RANGE;
    const value = Number.isFinite(raw) ? raw : DEFAULT_MUSIC_RANGE;
    MusicProximity.cachedRange = Math.max(MIN_RANGE_METERS, Math.min(MAX_RANGE_METERS, value));
    return MusicProximity.cachedRange;
  }

  private static gameTimer(): number {
    return typeof GetGameTimer === 'function' ? GetGameTimer() : 0;
  }

  /**
   * Where the broadcaster is, or `null` if this client cannot see them.
   *
   * `GetPlayerFromServerId` answers -1 for a player who is not streamed in — too far, or
   * in another routing bucket. That is neither a distance of zero nor an error: it is
   * "inaudible", which is what the `null` resolves to a few lines later.
   */
  private static coordsOf(source: number): number[] | null {
    const player = GetPlayerFromServerId(source);
    if (player === -1) return null;
    const ped = GetPlayerPed(player);
    if (!ped) return null;
    const coords = GetEntityCoords(ped, true);
    return coords && coords.length >= 3 ? coords : null;
  }

  private static start(): void {
    if (MusicProximity.tick !== null) return;
    MusicProximity.tick = setTick(() => MusicProximity.frame());
  }

  /** Emit one final empty set, so the shell is told to stop rather than left holding the last one. */
  private static stop(): void {
    MusicProximity.entries.clear();
    MusicProximity.clearTickIfRunning();
    MusicProximity.lastPushedIds = '';
    MusicProximity.lastPushAt = 0;
    MusicProximity.listener?.([]);
  }

  private static clearTickIfRunning(): void {
    if (MusicProximity.tick === null) return;
    clearTick(MusicProximity.tick);
    MusicProximity.tick = null;
  }

  private static frame(): void {
    const origin = GetEntityCoords(PlayerPedId(), true);
    const range = MusicProximity.range();
    const located = Boolean(origin && origin.length >= 3);

    for (const entry of MusicProximity.entries.values()) {
      let distance: number | null = null;
      if (located && !entry.retiring) {
        const coords = MusicProximity.coordsOf(entry.source);
        if (coords) {
          const dx = coords[0] - origin[0];
          const dy = coords[1] - origin[1];
          const dz = coords[2] - origin[2];
          distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
        }
      }
      entry.distance = distance;

      const gain = distance === null ? 0 : musicAttenuation(distance, range);
      if (entry.retiring) {
        entry.target = 0;
      } else if (entry.audible) {
        // Latched on: stays a candidate all the way down to silence.
        entry.audible = gain > SILENT_BELOW;
        entry.target = entry.audible ? gain : 0;
      } else {
        // Latched off: has to clear the deadband before it becomes a candidate again.
        entry.audible = gain >= AUDIBLE_ABOVE;
        entry.target = entry.audible ? gain : 0;
      }
    }

    // Frame-rate independent smoothing: the fraction of the remaining gap closed this
    // frame is a function of how long the frame was, so a 30fps client and a 144fps one
    // hear the same ramp rather than the same number of steps.
    const dt = typeof GetFrameTime === 'function' ? GetFrameTime() : 0;
    const alpha = dt > 0 ? 1 - Math.exp(-dt / SMOOTHING_TAU_SECONDS) : 1;

    let converged = true;
    for (const entry of MusicProximity.entries.values()) {
      if (Math.abs(entry.target - entry.volume) >= PUSH_EPSILON) converged = false;
      entry.volume += (entry.target - entry.volume) * alpha;
      if (entry.volume <= SILENT_BELOW) entry.volume = 0;
    }

    // A retiring entry only leaves once it has actually faded out.
    for (const [source, entry] of MusicProximity.entries) {
      if (entry.retiring && entry.volume === 0) MusicProximity.entries.delete(source);
    }
    if (MusicProximity.entries.size === 0) {
      MusicProximity.stop();
      return;
    }

    MusicProximity.maybePush(converged);
  }

  /**
   * Push at most every {@link PUSH_INTERVAL_MS}, and only while something is still moving.
   *
   * The tick runs per frame because the arithmetic is a handful of subtractions;
   * `SendNuiMessage` is the part that costs, so it is throttled and then gated on
   * convergence. A listener standing still therefore settles within about a second and
   * goes quiet — no messages at all until they or the roster move again.
   *
   * The gate is `|volume - target|` rather than "changed since the last push", which is
   * what guarantees the *last* message sent is within `PUSH_EPSILON` of the real target.
   * Gating on the delta would stop early and strand the volume wherever the throttle
   * happened to leave it.
   */
  private static maybePush(converged: boolean): void {
    const ids = [...MusicProximity.entries.keys()].sort((a, b) => a - b).join(',');
    const rosterChanged = ids !== MusicProximity.lastPushedIds;
    if (converged && !rosterChanged) return;

    const now = MusicProximity.gameTimer();
    if (!rosterChanged && now - MusicProximity.lastPushAt < PUSH_INTERVAL_MS) return;

    MusicProximity.lastPushAt = now;
    MusicProximity.lastPushedIds = ids;

    const levels: MusicLevel[] = [...MusicProximity.entries.values()].map((entry) => ({
      source: entry.source,
      volume: Math.max(0, Math.min(1, entry.volume)),
      distance: entry.distance
    }));
    levels.sort(byDistance);

    MusicProximity.listener?.(levels);
  }
}
