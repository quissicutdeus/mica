import { createCrudStore, byNewest } from './createCrudStore';
import { fetchNui } from '../nui/fetchNui';
import type { MediaItem, MediaPreview } from '@shared/types';

const store = createCrudStore<
  MediaItem,
  Omit<MediaItem, 'id' | 'citizenid' | 'created_at' | 'updated_at'>
>(
  'Media',
  { list: 'getMedia', create: 'createMedia', remove: 'deleteMedia' },
  { sort: byNewest<MediaItem>('created_at') }
);

export const media = {
  ...store,
  /**
   * Bluetooth proximity drop. Not list/create/update/delete, so it stays a named method
   * rather than stretching the CRUD factory — the same shape Mail's `archive` uses. The
   * copy this writes lands in a nearby recipient's own gallery, not this store, so there
   * is nothing here to patch locally.
   */
  dropNearby: async (mediaId: number): Promise<{ count: number }> =>
    fetchNui('shareMediaNearby', { mediaId }),
  /**
   * Share the caller's current in-game position. The reply is a freshly-created media row,
   * the same shape a photo pick already produces, so a caller can push it straight into an
   * attachment tray without a second fetch.
   */
  shareLocation: async (): Promise<{ id: number; media: MediaPreview }> =>
    fetchNui('shareLocation', {}),
  /** Set a GPS waypoint from a location a message already carries. Purely local in game. */
  setWaypoint: async (x: number, y: number): Promise<void> => {
    await fetchNui('setWaypoint', { x, y });
  }
};
