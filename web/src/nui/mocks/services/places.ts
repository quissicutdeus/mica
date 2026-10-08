// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  LIVE_SHARE_DURATIONS,
  type PlacesLiveState,
  type PlacesMapConfig
} from '@mica/shared/contracts/places';
import type { SavedPlace } from '@mica/shared/types';
import { mockContacts, mockSavedPlaces } from '../data';
import { defineMockCrud } from '../defineMockCrud';
import type { MockHandler } from '../registry';

/** The player's own live share, while one runs (MICA-244). */
let mockLiveShare: PlacesLiveState['outgoing'] = null;

/** The server's `places:live_share` push, which the status bar's indicator follows. */
const announceLiveShare = (payload: Record<string, unknown>): void => {
  if (typeof window === 'undefined') return;
  window.postMessage(
    { action: 'appEvent', data: { app: 'places', event: 'live_share', payload, at: Date.now() } },
    '*'
  );
};

export const mocks: Record<string, MockHandler> = {
  // Purely local in game (`SetNewWaypoint`); nothing for the browser to do but succeed.
  setWaypoint: async () => ({ ok: true }),

  // Places (MICA-65) — saved places only; recently-shared locations read `mockMedia`
  // (`services/media.ts`), filtered to `kind === 'location'`, the same way the real app
  // will. Stands in for `defineService({ id: 'places', ... })`, whose real `registerEvent` handlers
  // (Cody's server slice) exist alongside this mock now — kept for `pnpm dev`/Playwright.
  ...defineMockCrud<SavedPlace>(mockSavedPlaces, {
    list: 'places:get',
    create: 'places:create',
    update: 'places:update',
    remove: 'places:delete'
  }),

  // Places map and live sharing (MICA-244). No map image, so the neutral grid is what a
  // browser draws — the same thing an unconfigured server shows. The bounds and interval are
  // the server's defaults (`server/services/PlacesLive.ts`), restated as literals because
  // this transport never imports server code.
  'places:mapConfig': async (): Promise<PlacesMapConfig> => ({
    image: null,
    bounds: { minX: -5661, minY: -4058, maxX: 6694, maxY: 8429 },
    intervalSeconds: 2,
    durations: LIVE_SHARE_DURATIONS
  }),
  // The fake friend: Ursula walks a slow circle through Pillbox, so every poll moves her pin
  // and the map visibly animates in `pnpm dev` and in e2e.
  'places:live': async (): Promise<PlacesLiveState> => {
    const at = Date.now();
    const angle = (at / 30_000) * Math.PI * 2;
    if (mockLiveShare && mockLiveShare.expires_at <= at) mockLiveShare = null;
    return {
      self: { x: 215.3, y: -810.6 },
      outgoing: mockLiveShare,
      incoming: [
        {
          id: 1,
          number: '555-0199',
          x: 300 + Math.cos(angle) * 350,
          y: -600 + Math.sin(angle) * 350,
          updated_at: at,
          expires_at: at + 45 * 60_000
        }
      ]
    };
  },
  'places:startSharing': async (data: { contact_ids?: number[]; minutes?: number }) => {
    const ids = new Set(data?.contact_ids ?? []);
    const recipients = mockContacts.filter((c) => ids.has(c.id)).length;
    if (recipients === 0) throw new Error('None of those contacts can receive your location.');
    const minutes =
      LIVE_SHARE_DURATIONS.find((d) => d >= Number(data?.minutes ?? 0)) ??
      LIVE_SHARE_DURATIONS[LIVE_SHARE_DURATIONS.length - 1];
    mockLiveShare = { recipients, expires_at: Date.now() + minutes * 60_000 };
    announceLiveShare({ active: true, expires_at: mockLiveShare.expires_at });
    return mockLiveShare;
  },
  'places:stopSharing': async () => {
    mockLiveShare = null;
    announceLiveShare({ active: false });
    return { ok: true };
  }
};
