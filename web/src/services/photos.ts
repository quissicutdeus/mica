import { writable } from 'svelte/store';
import { fetchNui } from '../nui/fetchNui';
import type { Photo } from '@shared/types';

function createPhotosStore() {
  const { subscribe, set, update } = writable<Photo[]>([]);

  return {
    subscribe,
    load: async () => {
      const data = await fetchNui<Photo[]>('getPhotos', null, { defaultValue: [] });
      if (Array.isArray(data)) {
        // Newest first.
        set(
          data.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
        );
      } else {
        console.error('Photos store received invalid data:', data);
        set([]);
      }
    },
    // No `defaultValue` on the writes, so `fetchNui` throws and the caller can react.
    add: async (photo: Omit<Photo, 'id' | 'citizenid' | 'created_at' | 'updated_at'>) => {
      const newPhoto = await fetchNui<Photo>('createPhoto', photo);
      update((p) => [newPhoto, ...p]);
      return newPhoto;
    },
    delete: async (id: number) => {
      await fetchNui('deletePhoto', { id });
      update((p) => p.filter((c) => c.id !== id));
    }
  };
}

export const photos = createPhotosStore();
