import { createCrudStore, byNewest } from './createCrudStore';
import type { Photo } from '@shared/types';

export const photos = createCrudStore<
  Photo,
  Omit<Photo, 'id' | 'citizenid' | 'created_at' | 'updated_at'>
>(
  'Photos',
  { list: 'getPhotos', create: 'createPhoto', remove: 'deletePhoto' },
  { sort: byNewest<Photo>('created_at') }
);
