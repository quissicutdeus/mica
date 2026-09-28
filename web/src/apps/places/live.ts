// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { writable } from 'svelte/store';
import { useService } from '@mica/sdk';
import type { PlacesLiveState, PlacesMapConfig } from '@mica/shared/contracts/places';

/**
 * The map's data layer (MICA-244): the owner's map config and the live state the server
 * samples. Stores rather than component state, because the share indicator and the map both
 * read them and the app is resident — a share started before the player left Places is still
 * running when they come back.
 *
 * Nothing here sends a position. `live` takes no payload; the server reads every coordinate
 * it answers with from the game itself.
 */
const service = () => useService('places');

/** Until the server answers: the grid, the default atlas, the default interval. */
export const DEFAULT_MAP_CONFIG: PlacesMapConfig = {
  image: null,
  bounds: { minX: -5661, minY: -4058, maxX: 6694, maxY: 8429 },
  intervalSeconds: 5,
  durations: [15, 60, 240]
};

const EMPTY_LIVE: PlacesLiveState = { self: null, outgoing: null, incoming: [] };

export const mapConfig = writable<PlacesMapConfig>(DEFAULT_MAP_CONFIG);
export const liveState = writable<PlacesLiveState>(EMPTY_LIVE);

export const loadMapConfig = async (): Promise<PlacesMapConfig> => {
  const config = await service().call<PlacesMapConfig>('mapConfig', {}, DEFAULT_MAP_CONFIG);
  mapConfig.set(config);
  return config;
};

/** One poll. A failed round trip keeps the last answer rather than blanking the map. */
export const refreshLive = async (): Promise<void> => {
  const next = await service().call<PlacesLiveState | null>('live', {}, null);
  if (next) liveState.set(next);
};

/** Start sharing with these contacts. Throws on refusal, so `useAppAction` can toast it. */
export const startSharing = async (contactIds: number[], minutes: number): Promise<void> => {
  const outgoing = await service().call<{ recipients: number; expires_at: number }>(
    'startSharing',
    { contact_ids: contactIds, minutes }
  );
  liveState.update((state) => ({ ...state, outgoing }));
};

export const stopSharing = async (): Promise<void> => {
  await service().call('stopSharing', {});
  liveState.update((state) => ({ ...state, outgoing: null }));
};
