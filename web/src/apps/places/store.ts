// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createCrudStore } from '@mica/sdk';
import type { SavedPlace } from '@mica/shared/types';

/**
 * Saved places' own data layer, inside the app — same shape as `apps/notes/store.ts`.
 *
 * `service: 'places'`, so the four actions ride the generic service action by their server
 * names — `create` is contracted (`shared/contracts/places.ts`), the other three are the
 * generic CRUD `server/services/Places.ts` derives — and none of them needs a row in
 * `shared/routes.ts` (MICA-213). `routes.test.ts` still holds each to a registered server
 * event and a scoped browser mock.
 */
export const savedPlaces = createCrudStore<SavedPlace, Omit<SavedPlace, 'id' | 'citizenid'>>(
  'Saved Places',
  { list: 'get', create: 'create', update: 'update', remove: 'delete' },
  { service: 'places' }
);

export function useSavedPlaces() {
  return {
    savedPlacesStore: savedPlaces,
    addSavedPlace: (draft: Omit<SavedPlace, 'id' | 'citizenid' | 'created_at' | 'updated_at'>) => {
      const now = new Date().toISOString();
      return savedPlaces.add({ ...draft, created_at: now, updated_at: now });
    },
    renameSavedPlace: (place: SavedPlace, name: string) =>
      savedPlaces.update({ ...place, name, updated_at: new Date().toISOString() }),
    deleteSavedPlace: (id: number) => savedPlaces.delete(id)
  };
}
