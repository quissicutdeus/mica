// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MediaItem } from '@mica/shared/types';
import { mockLocationShare, mockMedia } from '../data';
import { defineMockCrud } from '../defineMockCrud';
import type { MockHandler } from '../registry';
import { delay, bluetoothNearbyCount } from '../shared';

export const mocks: Record<string, MockHandler> = {
  // Media and mail are soft-deleted, as the server does it: a removed row is still
  // there to be moderated.
  //
  // `getMedia` is overridden immediately below: `defineMockCrud` answers a list with a bare
  // array and every column, and the real read is paged and projected now (MICA-110). The
  // create and delete handlers are still exactly the generic ones.
  ...defineMockCrud<MediaItem>(
    mockMedia,
    { list: 'getMedia', create: 'createMedia', remove: 'deleteMedia' },
    {
      remove: 'soft',
      visible: (p) => p.status !== 'deleted',
      insert: 'prepend',
      defaults: { status: 'active' }
    }
  ),
  /**
   * The gallery list, paged and **without `data`** — the mock's whole job here.
   *
   * `data` is `private: true` on the service now, so the real read hands back a thumbnail
   * and metadata and nothing else. A mock that kept answering with the bytes would let the
   * grid go on drawing originals in `pnpm dev` and in Playwright while drawing placeholders
   * in game, which is §8's silent-layer failure pointing the other way.
   *
   * `data` is dropped and nothing is substituted for it, which is what makes
   * `mocks/data.ts`'s two thumbnail-less captures (950, 951) do their job: they arrive with
   * no image source at all, exactly as a photo taken before this shipped does, and that is
   * the only reason the grid's lazy hydrate-and-backfill path is reachable in a browser
   * rather than being code only the game can run.
   */
  getMedia: async ({ cursor, limit = 30 }: { cursor?: number; limit?: number } = {}) => {
    const visible = mockMedia
      .filter((p) => p.status !== 'deleted' && (cursor === undefined || p.id < cursor))
      .sort((a, b) => b.id - a.id);
    const page = visible.slice(0, limit);
    const hasMore = visible.length > page.length;
    return {
      // `delete` rather than a rest destructure, because the unused `data` binding a rest
      // destructure leaves behind is exactly what the linter is right to object to.
      rows: page.map((p) => {
        const projected = { ...p };
        delete projected.data;
        return projected;
      }),
      nextCursor: hasMore ? page[page.length - 1].id : null
    };
  },
  /**
   * The only path to the `thumbnail` column, and it has two callers.
   *
   * The camera writes one at capture time, and the gallery writes one back for a row that
   * arrived without — `AddMedia`'s `thumbnail` is optional, so other resources keep creating
   * those. Neither can ride along on `createMedia`, because the column is
   * `clientWritable: false`.
   *
   * Write-once against the fixture, exactly as the server's `thumbnail IS NULL` predicate
   * is, so a replay answers `{ stored: false }` and the browser sees the same "somebody got
   * there first" outcome the game does rather than a success the game would never report.
   */
  'media:thumbnail': async ({ id, thumbnail }: { id: number; thumbnail: string }) => {
    const row = mockMedia.find((p) => p.id === id && p.status === 'active');
    if (!row || row.thumbnail) return { stored: false };
    row.thumbnail = thumbnail;
    return { stored: true };
  },
  /** One row, bytes and all — what opening a photo, or hydrating a bare tile, asks for. */
  'media:item': async ({ id }: { id: number }) => {
    const row = mockMedia.find((p) => p.id === id && p.status !== 'deleted');
    if (!row) throw new Error('That photo could not be found.');
    return row;
  },
  // Bluetooth proximity drop. Scoped, because `web/` reaches it through the typed
  // `call(mediaContract, 'drop')` over the generic service action (MICA-213), and not
  // `defineMockCrud` — no CRUD verb fits copying a row to N nearby recipients.
  'media:drop': async () => {
    const count = bluetoothNearbyCount;
    if (count > 0 && typeof window !== 'undefined') {
      delay(150).then(() => {
        window.postMessage(
          {
            action: 'appEvent',
            data: {
              app: 'media',
              event: 'media_received',
              payload: {},
              at: Date.now(),
              notify: { title: 'Media received', message: 'A nearby phone sent you a photo.' }
            }
          },
          '*'
        );
      });
    }
    return { count };
  },
  // Location sharing. Fixed coordinates rather than anything real — the browser has no
  // ped position to read — matching the mock's job of exercising every layer above the
  // native call, not the native call itself.
  // Scoped, because `web/` reaches it through the typed `call(mediaContract, 'shareLocation')`
  // over the generic service action rather than a named route (MICA-213).
  'media:shareLocation': async () => ({ id: mockLocationShare.id, media: mockLocationShare }),

  // Recently Deleted (MICA-75-wiring). Scoped keys: both are contracted actions the web
  // reaches through the typed `call` rather than a named route (MICA-213).
  'media:getDeleted': () => mockMedia.filter((m) => m.status === 'deleted'),
  'media:restore': (data: { id?: number }) => {
    const item = mockMedia.find((m) => m.id === data?.id && m.status === 'deleted');
    if (!item) return { ok: false };
    item.status = 'active';
    return { ok: true };
  }
};
