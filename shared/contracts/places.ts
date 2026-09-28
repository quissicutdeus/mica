// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineContract, responseType } from '../contract';
import { s } from '../schema';
import type { SavedPlace } from '../types';

/** Most contacts one live share may name. Also bounds the lookups a start costs. */
export const MAX_LIVE_SHARE_RECIPIENTS = 10;

/** The durations a live share may run for, in minutes. The longest is the ceiling. */
export const LIVE_SHARE_DURATIONS = [15, 60, 240] as const;
export const MAX_LIVE_SHARE_MINUTES = 240;

/** GTA world coordinates of the map image's edges: x grows east, y grows north. */
export interface MapBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface PlacesMapConfig {
  /** An https URL or a `https://cfx-nui-…` path, or null for the neutral grid. */
  image: string | null;
  bounds: MapBounds;
  /** Seconds between position samples — `mica_location_interval`. */
  intervalSeconds: number;
  durations: readonly number[];
}

/** One position, as the server last sampled it. */
export interface LivePosition {
  x: number;
  y: number;
}

/** A share naming the caller. `number` is the sharer's phone number, for a contact lookup. */
export interface IncomingLiveShare extends LivePosition {
  number: string;
  /** Epoch ms of the sample. */
  updated_at: number;
  expires_at: number;
}

export interface PlacesLiveState {
  self: LivePosition | null;
  outgoing: { recipients: number; expires_at: number } | null;
  incoming: IncomingLiveShare[];
}

/**
 * Saved places, and since MICA-244 the map and live location sharing.
 *
 * Saved places have one custom action, and it is called `create`.
 *
 * The generic `create` is disabled, because the coordinates are read from the player's own
 * position server-side and a payload has no business naming them. What replaces it is a
 * hand-written handler, so it is a custom action and belongs here like any other — the
 * distinction `ServiceEndpoint` makes is the registration path, never the name.
 *
 * Both string bounds are the declared column lengths, so a name that would not fit is refused
 * rather than silently shortened on the way in.
 */
export const placesContract = defineContract({
  id: 'places',
  actions: {
    create: {
      input: s.object({
        name: s.string({ min: 1, max: 100 }),
        /**
         * Cosmetic display text only, the same trust level `media:shareLocation`'s `label`
         * carries — never resolved against anything, never used to authorize a read.
         */
        street_label: s.string({ min: 1, max: 255 }).optional()
      }),
      output: responseType<{ id: number; place: SavedPlace | null }>()
    },
    /** The owner's map image and world bounds, and the live-sharing interval (MICA-244). */
    mapConfig: { input: s.none(), output: responseType<PlacesMapConfig>() },
    /**
     * Everything the map draws that moves: the caller's own position, their outgoing share,
     * and every share naming them — all read server-side. Polled at the configured interval
     * while the map is on screen, so it takes no payload at all.
     */
    live: { input: s.none(), output: responseType<PlacesLiveState>() },
    /**
     * Start (or replace) the caller's live share. `contact_ids` are rows of the caller's own
     * address book, never phone numbers or players: the server reads each one under the
     * caller's ownership predicate, so a share can only reach someone the sharer saved.
     * `minutes` is snapped to `LIVE_SHARE_DURATIONS` server-side.
     */
    startSharing: {
      input: s.object({
        contact_ids: s.array(s.int({ min: 1 }), { min: 1, max: MAX_LIVE_SHARE_RECIPIENTS }),
        minutes: s.int({ min: 1, max: MAX_LIVE_SHARE_MINUTES })
      }),
      output: responseType<{ recipients: number; expires_at: number }>()
    },
    /** End the caller's live share now. Idempotent. */
    stopSharing: { input: s.none(), output: responseType<{ ok: true }>() }
  }
});
