// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PlayerFacingError } from '../lib/errors';
import { FrameworkBridge } from '../lib/FrameworkBridge';
import { playerCoords } from '../lib/playerCoords';
import { resolveByPhone } from '../lib/PlayerDirectory';
import { brandingPath, brandingUrl } from '@mica/shared/ownerConfig';
import {
  LIVE_SHARE_DURATIONS,
  type IncomingLiveShare,
  type LivePosition,
  type MapBounds,
  type PlacesLiveState,
  type PlacesMapConfig
} from '@mica/shared/contracts/places';
import { places } from './Places';
import { contacts } from './Contacts';
import { blockedBy } from './Blocklist';

/**
 * The Places map and live location sharing (MICA-244).
 *
 * **Where a position comes from.** Always the server's own view of the sharer's ped
 * (`playerCoords`), sampled every `mica_location_interval` seconds by the loop below. No
 * action here accepts a coordinate, so a modified client can lie about nothing but which of
 * its own contacts it picked.
 *
 * **Who may see it.** The recipients are fixed when the share starts: each `contact_ids`
 * entry is read from the sharer's own address book under their ownership predicate, its
 * number resolved to a character, and anyone who has blocked the sharer's number dropped.
 * `live` then answers a caller only with the shares whose recipient set names them.
 *
 * **What bounds it.** One share per sharer (a new start replaces the old), at most
 * `MAX_LIVE_SHARE_RECIPIENTS` recipients, a duration snapped to `LIVE_SHARE_DURATIONS`, a hard
 * expiry, and the end of the share the moment the sharer is no longer online. Nothing is
 * written to the database: a share is gone at a restart, which is the safe way to fail.
 */

// ─── owner configuration ─────────────────────────────────────────────────────

/**
 * The common 8192px GTA V atlas, in world coordinates: the edges a Leaflet map of that image
 * uses (`scale 0.02072/0.0205`, `center 117.3/172.8` over a 256px tile). An owner whose image
 * is cropped differently sets `mica_map_bounds`.
 */
export const DEFAULT_MAP_BOUNDS: MapBounds = { minX: -5661, minY: -4058, maxX: 6694, maxY: 8429 };

export const DEFAULT_LOCATION_INTERVAL = 5;
/** Floor and ceiling on the interval. The floor keeps the map's poll under `mica_rate_limit`. */
export const MIN_LOCATION_INTERVAL = 2;
export const MAX_LOCATION_INTERVAL = 60;

/** Longest map image URL accepted; anything longer is a mistake, not a map. */
const MAX_IMAGE_URL = 2048;

/**
 * A host, an optional port, and a path free of whitespace, quotes, angle brackets and
 * backslashes. No `URL` global on the server runtime, and a pattern is stricter anyway.
 */
const HTTPS_URL = /^https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?(?:\/[^\s"'<>\\]*)?$/;

/** Most shares one `live` answer carries. Nobody is watching more friends than this at once. */
export const MAX_INCOMING_SHARES = 20;

const warned = new Set<string>();
const warnOnce = (key: string, message: string): void => {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[micaOS] ${message}`);
};

/** Literal names at each call site: `convars.test.ts` reads them there. */
const hasConvars = (): boolean => typeof GetConvar === 'function';

/**
 * `mica_map_image`: an https URL, or a file under `branding/` served by this resource.
 * Anything else is refused, named once, and the phone draws its neutral grid instead —
 * micaOS ships no map image, because the game's own is not ours to license.
 */
export const parseMapImage = (raw: string, resource: string): string | null => {
  const text = raw.trim();
  if (!text) return null;
  if (text.startsWith('https://')) {
    return text.length <= MAX_IMAGE_URL && HTTPS_URL.test(text) ? text : null;
  }
  const path = brandingPath(text);
  return path ? brandingUrl(resource, path) : null;
};

/** `mica_map_bounds`: `minX,minY,maxX,maxY`. Anything else is the default atlas. */
export const parseMapBounds = (raw: string): MapBounds | null => {
  const text = raw.trim();
  if (!text) return null;
  const parts = text.split(',').map((part) => Number(part.trim()));
  if (parts.length !== 4 || !parts.every((n) => Number.isFinite(n))) return null;
  const [minX, minY, maxX, maxY] = parts;
  if (minX >= maxX || minY >= maxY) return null;
  return { minX, minY, maxX, maxY };
};

/** `mica_location_interval`, in seconds, clamped. A non-number is the default. */
export const locationIntervalSeconds = (): number => {
  const raw =
    typeof GetConvarInt === 'function'
      ? GetConvarInt('mica_location_interval', DEFAULT_LOCATION_INTERVAL)
      : DEFAULT_LOCATION_INTERVAL;
  if (!Number.isFinite(raw)) return DEFAULT_LOCATION_INTERVAL;
  return Math.min(MAX_LOCATION_INTERVAL, Math.max(MIN_LOCATION_INTERVAL, Math.trunc(raw)));
};

export const mapConfig = (): PlacesMapConfig => {
  const resource = typeof GetCurrentResourceName === 'function' ? GetCurrentResourceName() : 'mica';
  const rawImage = hasConvars() ? GetConvar('mica_map_image', '') : '';
  const image = parseMapImage(rawImage, resource);
  if (rawImage.trim() && !image) {
    warnOnce(
      `image:${rawImage}`,
      `mica_map_image '${rawImage}' is neither an https URL nor a file under branding/; drawing the grid.`
    );
  }
  const rawBounds = hasConvars() ? GetConvar('mica_map_bounds', '') : '';
  const bounds = parseMapBounds(rawBounds);
  if (rawBounds.trim() && !bounds) {
    warnOnce(
      `bounds:${rawBounds}`,
      `mica_map_bounds '${rawBounds}' is not minX,minY,maxX,maxY; using the default atlas.`
    );
  }
  return {
    image,
    bounds: bounds ?? DEFAULT_MAP_BOUNDS,
    intervalSeconds: locationIntervalSeconds(),
    durations: LIVE_SHARE_DURATIONS
  };
};

// ─── live shares ─────────────────────────────────────────────────────────────

interface LiveShare {
  /** The sharer's number, which is how a recipient's phone names them. */
  number: string;
  recipients: Set<string>;
  expiresAt: number;
  position: LivePosition | null;
  sampledAt: number;
}

/** Keyed by the sharer's citizenid. One share each, so the map is bounded by the player count. */
const shares = new Map<string, LiveShare>();

let now: () => number = () => Date.now();
let timer: ReturnType<typeof setTimeout> | null = null;

export const __setLiveClock = (fn?: () => number): void => {
  now = fn ?? (() => Date.now());
};

export const __resetLiveShares = (): void => {
  shares.clear();
  if (timer !== null) clearTimeout(timer);
  timer = null;
};

/** The duration a request gets: the shortest allowed one at least as long as it asked for. */
export const snapDuration = (minutes: number): number =>
  LIVE_SHARE_DURATIONS.find((allowed) => allowed >= minutes) ??
  LIVE_SHARE_DURATIONS[LIVE_SHARE_DURATIONS.length - 1];

const sample = (citizenid: string, share: LiveShare): boolean => {
  const src = FrameworkBridge.getSourceByCitizenId(citizenid);
  // The sharer left, or switched character: the share ends with them.
  if (src === null || src === undefined) return false;
  const coords = playerCoords(src);
  if (coords) {
    share.position = { x: coords[0], y: coords[1] };
    share.sampledAt = now();
  }
  return true;
};

/**
 * One pass: drop what expired or lost its sharer, re-sample the rest. Exported for tests;
 * the loop calls it every `mica_location_interval` seconds while any share is live, and not
 * at all otherwise, so an idle server runs no timer for this.
 */
export const tickLiveShares = (): void => {
  const at = now();
  for (const [citizenid, share] of shares) {
    if (at >= share.expiresAt || !sample(citizenid, share)) shares.delete(citizenid);
  }
};

const schedule = (): void => {
  if (timer !== null || shares.size === 0 || typeof setTimeout !== 'function') return;
  // Re-read each pass, so a `set` from the console takes effect without a restart.
  timer = setTimeout(() => {
    timer = null;
    try {
      tickLiveShares();
    } catch (error) {
      console.error('[micaOS] places: live share tick failed', error);
    }
    schedule();
  }, locationIntervalSeconds() * 1000);
};

/**
 * Who a share may reach: the caller's own, active contacts, resolved to characters, minus
 * the caller and anyone who has blocked the caller's number.
 */
const resolveRecipients = async (
  citizenid: string,
  phoneId: string | undefined,
  contactIds: readonly number[],
  sharerNumber: string
): Promise<string[]> => {
  const rows = await Promise.all(
    [...new Set(contactIds)].map((id) => contacts.repo.findById(id, citizenid, phoneId))
  );
  const numbers = new Set<string>();
  for (const row of rows) {
    if (row && row.status === 'active' && typeof row.phone === 'string' && row.phone) {
      numbers.add(row.phone);
    }
  }
  const resolved = await Promise.all([...numbers].map((number) => resolveByPhone(number)));
  const recipients = new Set<string>();
  for (const entry of resolved) {
    if (entry?.citizenid && entry.citizenid !== citizenid) recipients.add(entry.citizenid);
  }
  const blocked = await blockedBy([...recipients], sharerNumber);
  return [...recipients].filter((cid) => !blocked.has(cid));
};

export const liveStateFor = (source: number, citizenid: string): PlacesLiveState => {
  const at = now();
  const coords = playerCoords(source);
  const own = shares.get(citizenid);
  const incoming: IncomingLiveShare[] = [];
  for (const share of shares.values()) {
    if (incoming.length >= MAX_INCOMING_SHARES) break;
    if (share.expiresAt <= at || !share.position || !share.recipients.has(citizenid)) continue;
    incoming.push({
      number: share.number,
      x: share.position.x,
      y: share.position.y,
      updated_at: share.sampledAt,
      expires_at: share.expiresAt
    });
  }
  return {
    self: coords ? { x: coords[0], y: coords[1] } : null,
    outgoing:
      own && own.expiresAt > at
        ? { recipients: own.recipients.size, expires_at: own.expiresAt }
        : null,
    incoming
  };
};

const app = places.app;

app.registerEvent('mapConfig', async () => mapConfig());

app.registerEvent('live', async (source, _cbId, _data, citizenid) =>
  liveStateFor(source, citizenid)
);

app.registerEvent('startSharing', async (source, _cbId, data, citizenid, _player, phoneId) => {
  const number = FrameworkBridge.getPlayerPhone(source);
  if (!number) {
    throw new PlayerFacingError('Your phone has no number to share from.', {
      key: 'server.places.noNumber'
    });
  }
  const recipients = await resolveRecipients(citizenid, phoneId, data.contact_ids, number);
  if (recipients.length === 0) {
    throw new PlayerFacingError('None of those contacts can receive your location.', {
      key: 'server.places.noRecipients'
    });
  }
  const share: LiveShare = {
    number,
    recipients: new Set(recipients),
    expiresAt: now() + snapDuration(data.minutes) * 60_000,
    position: null,
    sampledAt: 0
  };
  const coords = playerCoords(source);
  if (coords) {
    share.position = { x: coords[0], y: coords[1] };
    share.sampledAt = now();
  }
  shares.set(citizenid, share);
  schedule();
  return { recipients: recipients.length, expires_at: share.expiresAt };
});

app.registerEvent('stopSharing', async (_source, _cbId, _data, citizenid) => {
  shares.delete(citizenid);
  return { ok: true as const };
});
