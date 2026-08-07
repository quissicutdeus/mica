import { createCrudStore, byNewest } from './createCrudStore';
import type { MediaItem } from '@shared/types';

export const photos = createCrudStore<
  MediaItem,
  Omit<MediaItem, 'id' | 'citizenid' | 'created_at' | 'updated_at'>
>(
  'Photos',
  { list: 'getPhotos', create: 'createPhoto', remove: 'deletePhoto' },
  { sort: byNewest<MediaItem>('created_at') }
);
