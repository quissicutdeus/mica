// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineContract, responseType } from '../contract';
import { s } from '../schema';

/**
 * Music broadcasting: what one player is playing, so nearby phones can hear it in sync.
 *
 * All three actions are custom — `music` has no table at all, only in-memory broadcast state
 * keyed by source, so there is no generic CRUD to derive.
 *
 * `positionMs` is deliberately client-authoritative and stays that way: only the broadcaster's
 * own player knows where it is in the track, and the worst a lying client achieves is
 * desynchronising the listeners of its own music. It is bounded anyway, because an unbounded
 * number here becomes a `startedAt` far enough into the past or the future to be arithmetic
 * nobody planned for — and the handler still clamps rather than refuses, since a position
 * slightly past the end of a track is a legitimate request with a wrong number in it.
 */
export const musicContract = defineContract({
  id: 'music',
  actions: {
    /**
     * Start, or replace, what this player is broadcasting.
     *
     * Four optional source fields and at least one is required — which the schema cannot say
     * and `sourceFrom` still does. A `url` is parsed for either id; `videoId`/`playlistId` are
     * taken directly if they are the right shape. Declaring all four keeps the strict object
     * from refusing the spelling the web actually sends while the handler decides which won.
     */
    broadcastStart: {
      input: s.object({
        url: s.string({ max: 2048 }).optional(),
        source: s.string({ max: 2048 }).optional(),
        videoId: s.string({ max: 64 }).optional(),
        playlistId: s.string({ max: 64 }).optional(),
        positionMs: s.number({ min: 0 }).optional()
      }),
      output: responseType<{ ok: boolean }>()
    },

    /** Pause, resume or seek. Every field optional — a bare seek sends no `paused` at all. */
    broadcastUpdate: {
      input: s.object({
        paused: s.boolean().optional(),
        positionMs: s.number({ min: 0 }).optional()
      }),
      output: responseType<{ ok: boolean; reason?: string }>()
    },

    broadcastStop: { input: s.none(), output: responseType<{ ok: boolean }>() }
  }
});
