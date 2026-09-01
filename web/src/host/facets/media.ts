// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { registerFacet } from '../../../../sdk/host/current';
import { media as mediaService } from '../../services/media';

/**
 * The media gallery — the client face of the `media` service.
 *
 * Split out of `useCamera`, which owned both the hardware and the library. They are
 * used by different apps for different reasons: Media reads the gallery and never
 * touches the shutter, and an app attaching an image to a message wants neither.
 */
export function media() {
  return {
    media: mediaService,
    // `kind` is stated rather than left to the column default: the table holds eight
    // kinds now, and a writer that does not say which one it is means the row's meaning
    // depends on a DDL default nobody reading this file can see.
    //
    // Two calls, not one, and that is the server's shape rather than a choice here:
    // `thumbnail` is `clientWritable: false`, so it cannot ride along on the create and
    // `setMediaThumbnail` is the only way it reaches the column. The row exists either
    // way — a thumbnail that fails to store costs the grid its small copy, not the photo.
    //
    // `thumbnail` is optional because only the camera can make one: it needs a canvas and
    // the pixels. A caller with bytes and no way to downscale them still writes a valid
    // row, and `MediaThumb` falls back to `data`.
    capturePhoto: async (data: string, thumbnail?: string) => {
      const row = await mediaService.add({ kind: 'photo', data });
      if (thumbnail && row?.id) {
        try {
          if (await mediaService.setThumbnail(row.id, thumbnail)) row.thumbnail = thumbnail;
        } catch (e) {
          console.warn('Capture saved, but its thumbnail could not be stored.', e);
        }
      }
      return row;
    },
    deletePhoto: async (id: number) => mediaService.delete(id),
    dropNearby: async (mediaId: number) => mediaService.dropNearby(mediaId),
    /**
     * One row with its bytes.
     *
     * Named on the facet rather than left to `media.full` on the store, because the store
     * an iframe gets is a `Readable` and has no methods on it at all. Every surface that
     * hands over an *original* rather than a tile needs this now that the list read carries
     * neither (MICA-110) — the avatar picker and the wallpaper picker both do, and both
     * are reachable from a sandboxed app.
     */
    fullMedia: async (mediaId: number) => mediaService.full(mediaId),
    /**
     * The "Recently Deleted" list (MICA-75-wiring). Named here rather than left to
     * `media.getDeleted`/`media.restore` on the store above, for the same reason
     * `fullMedia` already is: the store an iframe gets is a `Readable` with no methods on
     * it at all, so anything an add-on needs to call has to be its own facet member.
     */
    getDeletedMedia: () => mediaService.getDeleted(),
    restoreMedia: (mediaId: number) => mediaService.restore(mediaId)
  };
}

registerFacet('media', media);
