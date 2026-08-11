import { FrameworkBridge } from './FrameworkBridge';
import { getSettingsRepository } from '../services/Settings';

/**
 * Who is close enough, and Bluetooth-visible, to hand something to right now.
 *
 * Computed **on demand** rather than polled. Unlike `Signal.ts`'s reception, which has to
 * be current at all times because an app reads it continuously, proximity only matters at
 * the instant a player taps Share — so there is no interval, no cache, and nothing to
 * clean up on `playerDropped`.
 *
 * The visibility check is the one place the roadmap's anti-doxxing rule ("off means
 * invisible to proximity scans and unsolicited shares are refused") actually lives. It
 * reads the same `bluetooth_enabled` setting `web/src/shell/state/bluetooth.ts` writes,
 * through `Settings.ts`'s repository rather than a second copy of the default.
 */

const BLUETOOTH_SETTINGS_APP = 'settings';
const BLUETOOTH_SETTINGS_KEY = 'bluetooth_enabled';

/** Meters. Short-range, matching the roadmap's own framing of the feature. */
const DEFAULT_RANGE = 15;

const rangeMeters = (): number =>
  typeof GetConvarInt === 'function'
    ? GetConvarInt('gphone_bluetooth_range', DEFAULT_RANGE)
    : DEFAULT_RANGE;

/**
 * Where the player is, or null.
 *
 * Guarded exactly like `Signal.ts`'s `playerCoords`: these natives do not exist outside
 * the FiveM server runtime, and this module is imported by tests.
 */
const playerCoords = (src: number): [number, number, number] | null => {
  if (typeof GetPlayerPed !== 'function' || typeof GetEntityCoords !== 'function') return null;
  const ped = GetPlayerPed(String(src));
  if (!ped) return null;
  const coords = GetEntityCoords(ped) as unknown as number[];
  return coords && coords.length >= 3 ? [coords[0], coords[1], coords[2]] : null;
};

/**
 * `true` unless the player explicitly turned visibility off.
 *
 * Mirrors `usePersisted('settings', 'bluetooth_enabled', true)`'s own default — a missing
 * row is not a player who opted out, it is a player whose setting has never synced.
 */
const isVisibleValue = (raw: string | undefined): boolean => {
  if (raw === undefined) return true;
  try {
    return JSON.parse(raw) === true;
  } catch {
    return true;
  }
};

/**
 * Which of the given citizenids currently have Bluetooth Visibility on.
 *
 * One batched read rather than one query per candidate — the same reasoning
 * `getSourcesByCitizenId` already applies to resolving sources for a fan-out.
 */
const filterVisible = async (citizenids: string[]): Promise<Set<string>> => {
  const repo = getSettingsRepository();
  if (!repo) return new Set(citizenids); // Settings service not loaded yet: default open, same as the client.

  const values = await repo.getValuesFor(
    citizenids,
    BLUETOOTH_SETTINGS_APP,
    BLUETOOTH_SETTINGS_KEY
  );
  const visible = new Set<string>();
  for (const citizenid of citizenids) {
    if (isVisibleValue(values.get(citizenid))) visible.add(citizenid);
  }
  return visible;
};

export interface NearbyPlayer {
  source: number;
  citizenid: string;
}

/**
 * Everyone within Bluetooth range of `senderSource` who is currently visible.
 *
 * The sender's own visibility is not checked here — turning Bluetooth off hides a player
 * from being *found*, it does not stop them from initiating a share. Excludes the sender
 * regardless of citizenid duplication (a player cannot be their own nearby result).
 */
export async function findNearbyVisiblePlayers(
  senderSource: number,
  senderCitizenid: string
): Promise<NearbyPlayer[]> {
  const origin = playerCoords(senderSource);
  if (!origin) return [];

  const range = rangeMeters();
  const rangeSquared = range * range;
  const players = FrameworkBridge.getAllPlayers();

  const candidates: NearbyPlayer[] = [];
  for (const key of Object.keys(players)) {
    const src = Number(key);
    if (!Number.isFinite(src) || src === senderSource) continue;

    const citizenid = players[key]?.PlayerData?.citizenid;
    if (!citizenid || citizenid === senderCitizenid) continue;

    const coords = playerCoords(src);
    if (!coords) continue;

    const dx = coords[0] - origin[0];
    const dy = coords[1] - origin[1];
    const dz = coords[2] - origin[2];
    if (dx * dx + dy * dy + dz * dz > rangeSquared) continue;

    candidates.push({ source: src, citizenid });
  }

  if (candidates.length === 0) return [];

  const visible = await filterVisible(candidates.map((c) => c.citizenid));
  return candidates.filter((c) => visible.has(c.citizenid));
}
