import { describe, it, expect, vi, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { media } from './media';
import * as fetchNuiModule from '../nui/fetchNui';
/**
 * MICA-172: one stub, reached two ways.
 *
 * This service calls `fetchNui` **directly** for some operations and through
 * `createCrudStore` — which goes via the SDK's transport seam — for others. Spying on only
 * one of those leaves the other talking to the real transport, which in a node environment
 * dies inside `isBrowser()` and reads as fixture trouble rather than as a stub that never
 * applied. Pointing the seam at this module's spied namespace makes the single
 * `vi.spyOn(fetchNuiModule, 'fetchNui')` below cover both routes.
 */
import { registerNuiTransport } from '../../../sdk/nui/transport';
import * as thumbnailModule from '../../../sdk/lib/thumbnail';

const row = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  citizenid: 'CIT_1',
  kind: 'photo' as const,
  status: 'active' as const,
  created_at: '2026-08-01T10:00:00Z',
  updated_at: '2026-08-01T10:00:00Z',
  ...extra
});

/**
 * Route by action name rather than by call order.
 *
 * Several of these paths fire more than one request, and `mockResolvedValueOnce` chains
 * encode an ordering the code is free to change. Answering by name asserts what each call
 * *asked for*, which is the thing that would actually be wrong.
 */
const respond = (answers: Record<string, unknown>) =>
  vi
    .spyOn(fetchNuiModule, 'fetchNui')
    .mockImplementation(async (action: string) =>
      action in answers ? answers[action] : undefined
    );

describe('media store', () => {
  beforeEach(() => {
    registerNuiTransport((...args) => fetchNuiModule.fetchNui(...args));
    vi.restoreAllMocks();
  });

  describe('the paged list', () => {
    it('loads a page of rows and tracks whether the server has more', async () => {
      respond({ getMedia: { rows: [row(2), row(1)], nextCursor: 1 } });

      await media.load();

      expect(get(media).map((r) => r.id)).toEqual([2, 1]);
      expect(get(media.hasMore)).toBe(true);
      expect(get(media.loaded)).toBe(true);
    });

    it('asks for a page rather than the whole table', async () => {
      const spy = respond({ getMedia: { rows: [], nextCursor: null } });
      spy.mockClear();

      await media.load();

      const [, payload] = spy.mock.calls[0];
      expect((payload as { limit?: number }).limit).toBeGreaterThan(0);
    });

    it('appends the next page onto the tail', async () => {
      respond({ getMedia: { rows: [row(9), row(8)], nextCursor: 8 } });
      await media.load();

      respond({ getMedia: { rows: [row(7)], nextCursor: null } });
      await media.loadMore();

      expect(get(media).map((r) => r.id)).toEqual([9, 8, 7]);
      expect(get(media.hasMore)).toBe(false);
    });
  });

  describe('opening one photo', () => {
    it('fetches the bytes by id', async () => {
      const spy = respond({ getMediaItem: row(4, { data: 'data:image/png;base64,FULL' }) });

      const full = await media.full(4);

      expect(spy).toHaveBeenCalledWith('getMediaItem', { id: 4 });
      expect(full.data).toBe('data:image/png;base64,FULL');
    });

    it('does not cache the bytes into the window', async () => {
      respond({ getMedia: { rows: [row(4, { thumbnail: 'thumb' })], nextCursor: null } });
      await media.load();

      respond({ getMediaItem: row(4, { data: 'data:image/png;base64,FULL' }) });
      await media.full(4);

      // Fifty opens would otherwise rebuild exactly the memory footprint this removes.
      expect(get(media)[0].data).toBeUndefined();
    });
  });

  describe('hydrating a row whose bytes would draw', () => {
    it('fetches the bytes and keeps them in the window', async () => {
      respond({ getMedia: { rows: [row(30)], nextCursor: null } });
      await media.load();

      const spy = respond({ getMediaItem: row(30, { data: 'data:image/png;base64,OLD' }) });
      spy.mockClear();

      media.hydrate(row(30));

      await vi.waitFor(() => expect(get(media)[0].data).toBe('data:image/png;base64,OLD'));
      expect(spy).toHaveBeenCalledWith('getMediaItem', { id: 30 });
    });

    it('asks again after a reload, because the reload stripped the bytes off again', async () => {
      respond({
        getMedia: { rows: [row(34)], nextCursor: null },
        getMediaItem: row(34, { data: 'data:image/png;base64,OLD' })
      });

      await media.load();
      media.hydrate(row(34));
      await vi.waitFor(() => expect(get(media)[0].data).toBe('data:image/png;base64,OLD'));

      await media.load();
      expect(get(media)[0].data).toBeUndefined();

      // Without `load` clearing the attempted set, "ask once" would mean the row stays a
      // grey placeholder for the rest of the session.
      media.hydrate(row(34));
      await vi.waitFor(() => expect(get(media)[0].data).toBe('data:image/png;base64,OLD'));
    });

    it('asks for a given row once, however often the grid redraws it', async () => {
      const spy = respond({ getMediaItem: row(31, { data: 'data:image/png;base64,OLD' }) });
      spy.mockClear();

      media.hydrate(row(31));
      media.hydrate(row(31));
      media.hydrate(row(31));

      await vi.waitFor(() =>
        expect(spy.mock.calls.filter(([action]) => action === 'getMediaItem')).toHaveLength(1)
      );
    });

    it('hands a thumbnail back so the row never costs full size again', async () => {
      respond({ getMedia: { rows: [row(35)], nextCursor: null } });
      await media.load();

      const spy = respond({
        getMediaItem: row(35, { data: 'data:image/png;base64,OLD' }),
        setMediaThumbnail: { stored: true }
      });
      vi.spyOn(thumbnailModule, 'makeThumbnail').mockResolvedValue('data:image/webp;base64,SMALL');

      media.hydrate(row(35));

      await vi.waitFor(() =>
        expect(spy).toHaveBeenCalledWith('setMediaThumbnail', {
          id: 35,
          thumbnail: 'data:image/webp;base64,SMALL'
        })
      );

      // And the window keeps the small copy rather than the original. Both writers go
      // through `setThumbnail` precisely so this holds for the camera's capture and for a
      // hydrated row alike — the hydrated ones being the heaviest rows there are.
      await vi.waitFor(() => expect(get(media)[0].data).toBeUndefined());
      expect(get(media)[0].thumbnail).toBe('data:image/webp;base64,SMALL');
    });

    it('keeps the bytes when the write-back did not land', async () => {
      respond({ getMedia: { rows: [row(37)], nextCursor: null } });
      await media.load();

      respond({
        getMediaItem: row(37, { data: 'data:image/png;base64,OLD' }),
        // Somebody got there first, the row is not ours, or it is not active. Not an error.
        setMediaThumbnail: { stored: false }
      });
      vi.spyOn(thumbnailModule, 'makeThumbnail').mockResolvedValue('data:image/webp;base64,SMALL');

      media.hydrate(row(37));

      // Nothing was stored, so the fetched bytes are all this tile has to draw with.
      await vi.waitFor(() => expect(get(media)[0].data).toBe('data:image/png;base64,OLD'));
      expect(get(media)[0].thumbnail).toBeUndefined();
    });

    it('still draws the row when the write-back is refused', async () => {
      respond({ getMedia: { rows: [row(36)], nextCursor: null } });
      await media.load();

      respond({ getMediaItem: row(36, { data: 'data:image/png;base64,OLD' }) });
      vi.spyOn(thumbnailModule, 'makeThumbnail').mockResolvedValue(null);

      media.hydrate(row(36));

      // A refused backfill costs the next open a refetch, not this one a blank tile.
      await vi.waitFor(() => expect(get(media)[0].data).toBe('data:image/png;base64,OLD'));
    });

    it('leaves the tile drawable when the row cannot be fetched', async () => {
      respond({ getMedia: { rows: [row(32, { thumbnail: 'thumb' }), row(33)], nextCursor: null } });
      await media.load();

      vi.spyOn(fetchNuiModule, 'fetchNui').mockRejectedValue(new Error('gone'));
      media.hydrate(row(33));

      // A refusal must not blank the window: the placeholder stands and the row beside it
      // keeps the thumbnail it already had.
      await vi.waitFor(() => expect(get(media)).toHaveLength(2));
      expect(get(media)[0].thumbnail).toBe('thumb');
      expect(get(media)[1].data).toBeUndefined();
    });
  });

  /**
   * The predicate, kind by kind.
   *
   * "Has no bytes" is true of every row the list read returns, and it is not the question.
   * The question is whether fetching the bytes would yield something `MediaThumb` can draw
   * — a `data:image/` source — and for five of the eight kinds it would not. Getting this
   * wrong is silent and expensive rather than visibly broken: the payload arrives, `safe()`
   * rejects it, the same placeholder is drawn, and the round trip is spent. Shipped fixture
   * 903 (a `location`) was doing exactly that on every gallery open.
   *
   * A unit test rather than an e2e, deliberately: the browser mock records reply shape and
   * not request ids, so the only e2e available would count calls and race the queue, while
   * this is pure logic and can name the kind it means.
   */
  describe('which rows are worth hydrating', () => {
    let counter = 0;

    /**
     * Offer one row and count what actually went to the server.
     *
     * `hydrate` returns immediately and does its fetch on a queue, so the count has to be
     * read after the queue has drained — a macrotask, which lands after every pending
     * microtask in that chain. A fresh id each time, because a row already asked for is
     * skipped for a reason that has nothing to do with its kind.
     */
    const hydrateCalls = async (item: Record<string, unknown>) => {
      const candidate = { ...row(200 + counter++), ...item };
      const spy = respond({ getMediaItem: candidate });
      spy.mockClear();

      media.hydrate(candidate);
      await new Promise((resolve) => setTimeout(resolve, 0));

      return spy.mock.calls.filter(([action]) => action === 'getMediaItem');
    };

    it.each(['photo', 'gif', 'sticker'])(
      'fetches a bare %s — its bytes are an image',
      async (kind) => {
        expect(await hydrateCalls({ kind })).toHaveLength(1);
      }
    );

    it.each(['location', 'audio', 'file', 'link', 'video'])(
      'leaves a bare %s alone — its bytes would not draw',
      async (kind) => {
        expect(await hydrateCalls({ kind })).toHaveLength(0);
      }
    );

    it('leaves a photo that already has a thumbnail alone', async () => {
      expect(await hydrateCalls({ kind: 'photo', thumbnail: 'thumb' })).toHaveLength(0);
    });

    it('leaves a photo that already has its bytes alone', async () => {
      expect(await hydrateCalls({ kind: 'photo', data: 'data:image/png;base64,X' })).toHaveLength(
        0
      );
    });

    it('leaves a hotlinked photo alone — the url is the still', async () => {
      expect(await hydrateCalls({ kind: 'photo', url: 'https://e.invalid/p.png' })).toHaveLength(0);
    });
  });

  describe('an incoming drop', () => {
    it('prepends what it does not already hold, newest first', async () => {
      respond({ getMedia: { rows: [row(40)], nextCursor: null } });
      await media.load();

      respond({ getMedia: { rows: [row(42), row(41), row(40)], nextCursor: null } });
      await media.receive(42);

      expect(get(media).map((r) => r.id)).toEqual([42, 41, 40]);
    });

    it('does not refetch the library when the pushed row is already held', async () => {
      respond({ getMedia: { rows: [row(50), row(49)], nextCursor: null } });
      await media.load();

      // `vi.spyOn` hands back the *existing* spy for an already-mocked method, so the
      // `load()` above is on its call list until this clears it.
      const spy = respond({ getMedia: { rows: [], nextCursor: null } });
      spy.mockClear();

      await media.receive(50);

      // Named rather than `not.toHaveBeenCalled()`: `hydrate`'s queue is module-level and a
      // backfill from an earlier test can still be in flight, and the claim here is about
      // the list read specifically, not about the transport being idle.
      expect(spy.mock.calls.map(([action]) => action)).not.toContain('getMedia');
      expect(get(media).map((r) => r.id)).toEqual([50, 49]);
    });

    it('keeps the pages already scrolled through', async () => {
      respond({ getMedia: { rows: [row(60), row(59)], nextCursor: 59 } });
      await media.load();
      respond({ getMedia: { rows: [row(58)], nextCursor: null } });
      await media.loadMore();

      respond({ getMedia: { rows: [row(61), row(60), row(59)], nextCursor: null } });
      await media.receive(61);

      // `load()` here would have thrown away row 58 to show row 61.
      expect(get(media).map((r) => r.id)).toEqual([61, 60, 59, 58]);
    });
  });

  describe('writes', () => {
    it('puts a fresh capture at the head', async () => {
      respond({ getMedia: { rows: [row(70)], nextCursor: null } });
      await media.load();

      const created = row(71, { data: 'data:image/png;base64,NEW', thumbnail: 'small' });
      respond({ createMedia: created });

      const result = await media.add({ kind: 'photo', data: 'data:image/png;base64,NEW' });

      expect(result).toEqual(created);
      expect(get(media).map((r) => r.id)).toEqual([71, 70]);
    });

    it('drops a deleted row out of the window', async () => {
      respond({ getMedia: { rows: [row(80), row(81)], nextCursor: null } });
      await media.load();

      respond({ deleteMedia: true });
      await media.delete(80);

      expect(get(media).map((r) => r.id)).toEqual([81]);
    });
  });
});
