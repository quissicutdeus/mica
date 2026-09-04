// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { FrameworkBridge } from './FrameworkBridge';
import { getSettingsRepository } from '../services/Settings';
import { playerCoords } from './playerCoords';

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

/**
 * How many phones one Bluetooth gesture reaches, when a server sets nothing.
 *
 * Range alone was never a bound on *how many*: fifteen meters is a doorway on a quiet
 * street and a full nightclub on a busy one, and every caller here fans out per recipient
 * — Media's drop writes each of them their own copy of the payload, Contacts emits each of
 * them a packet. So an uncapped scan turns one tap into however many people happen to be
 * standing there, which is the griefing surface `mica_music_max_nearby` already exists
 * to close on the music side.
 *
 * Five is the gesture the feature is actually for — handing something to the people around
 * you — rather than a number chosen to be safe. Nearest first, so what falls off the end
 * is whoever was furthest from the person who tapped.
 */
const DEFAULT_MAX_NEARBY = 5;

/**
 * The ceiling `mica_bluetooth_max_nearby` cannot be raised past.
 *
 * A convar is a server owner's dial, not a licence, exactly as `MAX_NEARBY_BROADCASTS` is
 * for music. The cost here is a database row per recipient holding a full copy of whatever
 * was shared, so this is what bounds one tap's write amplification.
 */
const MAX_NEARBY = 16;

const rangeMeters = (): number =>
  typeof GetConvarInt === 'function'
    ? GetConvarInt('mica_bluetooth_range', DEFAULT_RANGE)
    : DEFAULT_RANGE;

/**
 * How many recipients one scan may name, clamped to `MAX_NEARBY`.
 *
 * A non-numeric or non-positive value falls back to the default rather than disabling the
 * feature — `mica_bluetooth_range` is the knob that turns proximity sharing off, and a
 * typo in this one should not silently do the same thing by another route.
 */
const maxNearby = (): number => {
  const raw =
    typeof GetConvarInt === 'function'
      ? GetConvarInt('mica_bluetooth_max_nearby', DEFAULT_MAX_NEARBY)
      : DEFAULT_MAX_NEARBY;
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_MAX_NEARBY;
  return Math.min(Math.trunc(raw), MAX_NEARBY);
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
 * The nearest few players within Bluetooth range of `senderSource` who are currently
 * visible, closest first and no more than `mica_bluetooth_max_nearby` of them.
 *
 * The sender's own visibility is not checked here — turning Bluetooth off hides a player
 * from being *found*, it does not stop them from initiating a share. Excludes the sender
 * regardless of citizenid duplication (a player cannot be their own nearby result).
 *
 * **The cap is applied after the visibility filter, not before it** (MICA-115). Slicing
 * the candidate list first would let players who have opted out of proximity entirely
 * consume the slots, so a crowd of invisible bystanders would silently shrink a share to
 * nobody — the ordering has to decide who is *reached*, not who is considered.
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

  const candidates: (NearbyPlayer & { distanceSquared: number })[] = [];
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
    const distanceSquared = dx * dx + dy * dy + dz * dz;
    if (distanceSquared > rangeSquared) continue;

    candidates.push({ source: src, citizenid, distanceSquared });
  }

  if (candidates.length === 0) return [];

  // Nearest wins, stated as a rule rather than left to iteration order — it decides who a
  // share reaches once there are more people in range than the cap allows.
  candidates.sort((a, b) => a.distanceSquared - b.distanceSquared);

  const visible = await filterVisible(candidates.map((c) => c.citizenid));
  return candidates
    .filter((c) => visible.has(c.citizenid))
    .slice(0, maxNearby())
    .map(({ source, citizenid }) => ({ source, citizenid }));
}
