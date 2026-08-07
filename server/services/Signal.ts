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
 * ## Why the client computes the final number
 *
 * The server does not know where anybody is without asking, and asking every player every
 * tick is exactly the cost this is trying to avoid. So the server owns the *rules* — the
 * global level and the zone list, both small — pushes them on change, and each client
 * evaluates its own position against them.
 *
 * That means a modified client can lie about its own bars. It is worth being explicit that
 * this is **fine**: signal gates presentation, not authority. §2.9 still stands — the
 * server authorises every privileged action regardless of what the phone believes, so the
 * worst a faked signal buys is a UI that draws four bars in a tunnel.
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
 * Push the rules to everyone, or to one source.
 *
 * Broadcast on change rather than polled, because the rules change rarely and a poll would
 * put a request per player per interval on the wire for an answer that is usually the same
 * one. A joining client asks once (`gphone:server:signal:rules`).
 */
const broadcastRules = (target?: number): void => {
  if (typeof emitNet !== 'function') return;
  emitNet('gphone:client:signal:rules', target ?? -1, currentRules());
};

export const setGlobalSignal = (level: number): number => {
  globalLevel = clampLevel(level);
  broadcastRules();
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
  broadcastRules();
  return created;
};

export const removeDeadZone = (id: number): boolean => {
  const existed = zones.delete(id);
  if (existed) broadcastRules();
  return existed;
};

export const setPlayerSignal = (src: number, level: number | null): void => {
  if (level === null) overrides.delete(src);
  else overrides.set(src, clampLevel(level));

  if (typeof emitNet === 'function') {
    emitNet('gphone:client:signal:override', src, level === null ? null : clampLevel(level));
  }
};

export const playerOverride = (src: number): number | null => overrides.get(src) ?? null;

/**
 * A joining client asks for the rules once; it has no way to know them otherwise.
 *
 * A literal, not a template. `eventNames.test.ts` scans for string **literals**, so
 * `gphone:server:${SERVICE}:rules` would be an *unchecked* name — it would pass by being
 * invisible rather than by being right (§8).
 */
onNet('gphone:server:signal:rules', () => {
  const src = source;
  broadcastRules(src);
  const override = overrides.get(src);
  if (override !== undefined && typeof emitNet === 'function') {
    emitNet('gphone:client:signal:override', src, override);
  }
});

on('playerDropped', () => {
  // FiveM reuses server ids, so an override left behind is one the next player inherits —
  // they would join with no bars and nothing on screen explaining why.
  overrides.delete(source);
});

/** For the `GetSignal` export: the rules a player is subject to, without their position. */
export const describeSignalFor = (src: number): { override: number | null; global: number } => ({
  override: playerOverride(src),
  global: globalLevel
});

/** Only used to prove a source is a connected player before overriding them. */
export const isConnected = (src: number): boolean => Boolean(FrameworkBridge.getPlayer(src));
