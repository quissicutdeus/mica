import { writable } from 'svelte/store';
import { fetchNui } from '../utils/fetchNui';
import type { Photo } from '@shared/types';

function createPhotosStore() {
  const { subscribe, set, update } = writable<Photo[]>([]);

  return {
    subscribe,
    load: async () => {
      const data = await fetchNui<Photo[]>('getPhotos', null, { defaultValue: [] });
      if (Array.isArray(data)) {
        // Debugging what we receive from the server
        if (data.length > 0) {
          console.log('Photo 0 image type:', typeof data[0].image);
          console.log('Photo 0 image substring:', String(data[0].image).substring(0, 50));
        }

        // Sort photos by created_at descending (newest first)
        set(
          data.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
        );
      } else {
        console.error('Photos store received invalid data:', data);
        set([]);
      }
    },
    add: async (photo: Omit<Photo, 'id' | 'citizenid' | 'created_at' | 'updated_at'>) => {
      try {
        const newPhoto = await fetchNui<Photo>('createPhoto', photo);
        if (newPhoto) {
          update((p) => [newPhoto, ...p]);
          return newPhoto;
        }
      } catch (e) {
        console.error('Failed to create photo:', e);
        throw e;
      }
    },
    delete: async (id: number) => {
      try {
        await fetchNui('deletePhoto', { id });
        update((p) => p.filter((c) => c.id !== id));
      } catch (e) {
        console.error('Failed to delete photo:', e);
      }
    }
  };
}

export const photos = createPhotosStore();
