import { createCrudStore } from '@gphone/sdk';
import type { SavedPlace } from '@shared/types';

/**
 * Saved places' own data layer, inside the app — same shape as `apps/notes/store.ts`.
 *
 * Unlike Notes, this stays on **named routes** rather than `service: 'places'`: Places is
 * `core: true` (MICA-65), so it keeps the same wiring every other in-tree service uses
 * (`shared/routes.ts`'s `getSavedPlaces`/`createSavedPlace`/`updateSavedPlace`/
 * `deleteSavedPlace`), which `routes.test.ts` cross-references against the server and the
 * browser mock.
 *
 * PENDING (Cody): no `defineService({ id: 'places', ... })` exists on the server yet — this
 * reaches only `web/src/nui/mocks/registry.ts` today. Every read/write below will throw in
 * game until that lands; the browser mock is what stands in for it in the meantime.
 */
export const savedPlaces = createCrudStore<SavedPlace, Omit<SavedPlace, 'id' | 'citizenid'>>(
  'Saved Places',
  {
    list: 'getSavedPlaces',
    create: 'createSavedPlace',
    update: 'updateSavedPlace',
    remove: 'deleteSavedPlace'
  }
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
