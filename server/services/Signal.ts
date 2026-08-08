// The server half of the signal service.
import { registerService } from '../lib/services';
import { FrameworkBridge } from '../lib/FrameworkBridge';

/**
 * Cellular reception: a city-wide level, a set of dead zones, and per-player overrides.
 *
 * Before this, `signalLevel` was a `writable(4)` in the NUI that only Developer Tools
 * could change — on your own phone. A dispatch script could not black out a district and
 * an EMP could not exist, because there was nothing to call. This is the state half; the
 * `SetGlobalSignal` / `AddDeadZone` exports in `lib/publicApi.ts` are how anything reaches
 * it.
 *
 * ## Why the zones are in memory and not a table
 *
 * A zone is placed by another resource at runtime — a jammer during a heist, a tunnel a
 * map script knows about, a solar flare an event runs. It belongs to the script that made
 * it and to that server session. Persisting them would mean a jammer outliving the heist
 * that placed it and nobody left knowing why a block has no bars. A restart clearing them
 * is the correct behavior rather than a limitation, and it is also why there is no
 * `defineService` here and no generated DDL.
 *
 * ## Why the server computes the final number
 *
 * It did not, at first. The server pushed the *rules* and each client evaluated its own
 * position, on the reasoning that polling every player's coordinates was the cost worth
 * avoiding — and that a faked signal only draws four bars in a tunnel.
 *
 * The second half of that is true **only while nothing reads the level**. The moment an
 * app degrades at zero bars — which is the whole point of dead zones — a client that
 * decides its own bars is a client that decides whether it is in a dead zone. That is not
 * presentation any more, and it would have shipped exploitable in the first version of the
 * feature that used it.
 *
 * So the server polls. The cost is real and was not imagined: one `GetEntityCoords` per
 * connected player per interval. It is bounded by an early-out — with no zones and full
 * global signal there is nothing a position could change, so the common case reads no
 * coordinates at all — and by pushing only when a player's whole-bar value moves.
 */
registerService('signal');

export interface DeadZone {
  id: number;
  x: number;
  y: number;
  z: number;
  radius: number;
  /** Bars inside the zone, 0-4. `0` is no service at all. */
  level: number;
}

/** Full bars. What a player has when nothing says otherwise. */
export const FULL_SIGNAL = 4;

/**
 * Squared distance, deliberately — comparing against `radius * radius` avoids a square
 * root per zone per player per poll, and the comparison is identical.
 */
const within = (x: number, y: number, z: number, zone: DeadZone): boolean => {
  const dx = x - zone.x;
  const dy = y - zone.y;
  const dz = z - zone.z;
  return dx * dx + dy * dy + dz * dz <= zone.radius * zone.radius;
};

/**
 * The precedence order, in one place.
 *
 * A per-player override wins outright — it is set *at* a player rather than at the world,
 * so it is not part of the comparison; otherwise there would be no way to give somebody
 * bars inside a blackout, which is most of why an override exists. Everything else is the
 * **same primitive**: the global level and every overlapping zone, lowest wins. Two
 * mechanisms would drift the first time they disagreed.
 */
export const evaluateSignal = (
  x: number,
  y: number,
  z: number,
  rules: { global: number; zones: DeadZone[] },
  playerOverride: number | null
): number => {
  if (playerOverride !== null) return playerOverride;

  let level = rules.global;
  for (const zone of rules.zones) {
    if (zone.level < level && within(x, y, z, zone)) level = zone.level;
  }
  return level;
};

let globalLevel = FULL_SIGNAL;
let nextZoneId = 1;
const zones = new Map<number, DeadZone>();

/**
 * Per-source overrides, which win over everything.
 *
 * A tinfoil hat, a jailed player, a scripted moment. Keyed by source rather than citizenid
 * because it is inherently live — it means nothing for a player who is not connected — and
 * cleared on drop, since FiveM reuses server ids and the next player would inherit it.
 */
const overrides = new Map<number, number>();

/** Test seam: module state that would otherwise leak between cases. */
export const __resetSignal = (): void => {
  globalLevel = FULL_SIGNAL;
  nextZoneId = 1;
  zones.clear();
  overrides.clear();
  // The push cache too, or a level pushed in one case suppresses the identical push in the
  // next and the assertion reads as "the server said nothing".
  lastPushed.clear();
};

const clampLevel = (level: number): number => Math.max(0, Math.min(FULL_SIGNAL, Math.round(level)));

/** What every client needs to evaluate its own position. */
export interface SignalRules {
  global: number;
  zones: DeadZone[];
}

export const currentRules = (): SignalRules => ({
  global: globalLevel,
  zones: [...zones.values()]
});

/**
 * Last whole-bar value pushed per source, so a poll that changes nothing says nothing.
 *
 * Without it the server would put a message per player on the wire every interval,
 * forever, to report a number that moves when somebody walks into a tunnel.
 */
const lastPushed = new Map<number, number>();

const POLL_MS = 2000;

/** Test seam: a deterministic poll, rather than waiting on the interval. */
export const pollSignal = (): void => {
  const rules = currentRules();

  /**
   * The early-out, and it is what makes polling affordable.
   *
   * With no zones and full global signal there is nothing a position could change, so the
   * ordinary case never asks the game where anybody is. Overrides still have to be
   * delivered, so they are handled before this returns.
   */
  const worldIsQuiet = rules.zones.length === 0 && rules.global >= FULL_SIGNAL;

  const players = FrameworkBridge.getAllPlayers();
  for (const key of Object.keys(players)) {
    const src = Number(key);
    if (!Number.isFinite(src)) continue;

    const override = overrides.get(src) ?? null;

    let level: number;
    if (override !== null) {
      level = override;
    } else if (worldIsQuiet) {
      level = FULL_SIGNAL;
    } else {
      const coords = playerCoords(src);
      // No ped yet — spawning, or between characters. Full bars beats a spurious blackout.
      level = coords ? evaluateSignal(coords[0], coords[1], coords[2], rules, null) : FULL_SIGNAL;
    }

    if (lastPushed.get(src) === level) continue;
    lastPushed.set(src, level);
    if (typeof emitNet === 'function') emitNet('gphone:client:signal:set', src, level);
  }
};

/**
 * Where the player is, or null.
 *
 * Guarded because these natives do not exist outside the FiveM server runtime, and this
 * module is imported by the SQL codegen and by tests.
 */
const playerCoords = (src: number): [number, number, number] | null => {
  if (typeof GetPlayerPed !== 'function' || typeof GetEntityCoords !== 'function') return null;
  const ped = GetPlayerPed(String(src));
  if (!ped) return null;
  const coords = GetEntityCoords(ped) as unknown as number[];
  return coords && coords.length >= 3 ? [coords[0], coords[1], coords[2]] : null;
};

if (typeof setInterval === 'function') setInterval(pollSignal, POLL_MS);

export const setGlobalSignal = (level: number): number => {
  globalLevel = clampLevel(level);
  pollSignal();
  return globalLevel;
};

export const addDeadZone = (zone: Omit<DeadZone, 'id'>): DeadZone => {
  const created: DeadZone = {
    id: nextZoneId++,
    x: zone.x,
    y: zone.y,
    z: zone.z,
    radius: Math.max(0, zone.radius),
    level: clampLevel(zone.level)
  };
  zones.set(created.id, created);
  pollSignal();
  return created;
};

export const removeDeadZone = (id: number): boolean => {
  const existed = zones.delete(id);
  if (existed) pollSignal();
  return existed;
};

export const setPlayerSignal = (src: number, level: number | null): void => {
  if (level === null) overrides.delete(src);
  else overrides.set(src, clampLevel(level));

  // Re-evaluate now rather than waiting out the interval: an override that takes two
  // seconds to show reads as the script having failed.
  pollSignal();
};

export const playerOverride = (src: number): number | null => overrides.get(src) ?? null;

/**
 * `gphone:server:signal:rules` is deliberately absent.
 *
 * A client used to ask for the zone list so it could evaluate its own position. It has no
 * reason to know the zones now — the server pushes a level, not the rules that produce one
 * — and a client that cannot see the zones cannot decide it is outside one.
 */

on('playerDropped', () => {
  // FiveM reuses server ids, so an override left behind is one the next player inherits —
  // they would join with no bars and nothing on screen explaining why.
  overrides.delete(source);
  lastPushed.delete(source);
});

/** For the `GetSignal` export: the rules a player is subject to, without their position. */
export const describeSignalFor = (src: number): { override: number | null; global: number } => ({
  override: playerOverride(src),
  global: globalLevel
});

/** Only used to prove a source is a connected player before overriding them. */
export const isConnected = (src: number): boolean => Boolean(FrameworkBridge.getPlayer(src));
