import { createCrudStore, byNewest } from './createCrudStore';
import { fetchNui } from '../nui/fetchNui';
import type { MediaItem } from '@shared/types';

const store = createCrudStore<
  MediaItem,
  Omit<MediaItem, 'id' | 'citizenid' | 'created_at' | 'updated_at'>
>(
  'Photos',
  { list: 'getPhotos', create: 'createPhoto', remove: 'deletePhoto' },
  { sort: byNewest<MediaItem>('created_at') }
);

export const photos = {
  ...store,
  /**
   * Bluetooth proximity drop. Not list/create/update/delete, so it stays a named method
   * rather than stretching the CRUD factory — the same shape Mail's `archive` uses. The
   * copy this writes lands in a nearby recipient's own gallery, not this store, so there
   * is nothing here to patch locally.
   */
  dropNearby: async (mediaId: number): Promise<{ count: number }> =>
    fetchNui('sharePhotoNearby', { mediaId })
};
