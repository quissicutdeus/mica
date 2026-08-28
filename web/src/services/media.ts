import { get } from 'svelte/store';
import { createPagedStore } from './createPagedStore';
import { fetchNui } from '../nui/fetchNui';
import { makeThumbnail } from '../lib/thumbnail';
import type { MediaItem, MediaPreview } from '@shared/types';

/**
 * Three columns, seven rows.
 *
 * The screen is a fixed 400x850 (§5), so a page is not a guess: at the ~123px a grid tile
 * actually measures, twenty-one tiles is one row taller than the visible area. That is the
 * property worth having — a first page that *underfills* the screen leaves the scroller
 * with nothing to scroll, so the handler that asks for page two never fires and the rest of
 * the library is unreachable.
 */
const PAGE_SIZE = 21;

/**
 * The gallery, a page of thumbnails at a time.
 *
 * Was a `createCrudStore`, which loads the whole table in one reply and holds it. That is
 * the wrong shape for a table whose rows are hundreds of kilobytes each: with `data` on
 * every row, opening the app moved the entire library across the NUI bridge to draw 123px
 * squares (MICA-110). The list read is projected down to `thumbnail` plus metadata now,
 * and the bytes are fetched one row at a time by `full` below.
 *
 * Keyset on `id DESC`, so the head of the window is the newest row and anything prepended
 * there — a fresh capture, an incoming drop — cannot disturb the cursor walking away from
 * the tail.
 */
const store = createPagedStore<MediaItem>('getMedia', { pageSize: PAGE_SIZE });

/**
 * Kinds whose own bytes are an image.
 *
 * The distinction `hydrate` turns on, and it is not the same question as "has no bytes".
 * `MediaThumb` will only draw a `data:image/` or an `https?:` source, so fetching `data`
 * is worth a round trip exactly where `data` would be an image — a photo, a GIF, a
 * sticker. A `location` stores JSON there, an `audio` row stores a clip, a `file` stores
 * whatever it is, and a `video`'s still lives in `thumbnail` rather than in its bytes;
 * pulling any of those back yields something `safe()` rejects and a placeholder drawn
 * either way, having paid the whole payload for it.
 *
 * Mirrors `MediaThumb`'s own `URL_IS_AN_IMAGE`, deliberately and separately: that one
 * asks whether a `url` may be used as a still, this one asks the same of `data`, and
 * collapsing them would tie two files to one set for a reason neither states.
 */
const BYTES_ARE_AN_IMAGE = new Set(['photo', 'gif', 'sticker']);

/**
 * Rows whose still has already been asked for, successfully or not.
 *
 * One attempt per row per list read, deliberately: a row that comes back without a
 * drawable still will do so every time, and a grid that retried on every re-render would
 * hammer the bridge for as long as the tile is on screen.
 */
const hydrated = new Set<number>();

/** Hydration runs one row at a time — see `hydrate`. */
let queue: Promise<void> = Promise.resolve();

/**
 * Encode a thumbnail for a row that has none, and give it back to the server.
 *
 * This is what makes `hydrate` a fix rather than a per-session workaround. Without it a row
 * created through `AddMedia` without a thumbnail costs its full bytes every time the gallery
 * is opened, forever; with it that download is paid **once** and the row is an ordinary
 * thumbnail row from then on.
 *
 * The encode is here because only the client has a canvas. Giving the server one means an
 * image library shipped to every server owner to re-derive pixels this process is already
 * holding (§2.5). `server/services/Media.ts`'s `thumbnail` action is ownership-scoped,
 * length-capped and write-once (`thumbnail IS NULL`), so a second call for a row that
 * already has one is a no-op rather than an error — which matters, because two tiles or two
 * sessions racing the same photo is normal.
 *
 * Best-effort. The row is already drawn by the time this runs, so a refusal costs the player
 * nothing visible; it only means the next open pays for the bytes again. `makeThumbnail`
 * answers `null` rather than throwing for an image it cannot decode.
 */
const backfill = async (row: MediaItem): Promise<void> => {
  if (!row.data) return;
  try {
    const thumbnail = await makeThumbnail(row.data);
    if (!thumbnail) return;
    // Through `setThumbnail` rather than calling the action directly, so both writers
    // behave the same on success: it reads `stored` and patches the window row with
    // `data: undefined`. Calling `fetchNui` here instead left the full payload in the
    // window for the rest of the session — for exactly the rows that were most expensive
    // to fetch, which is the memory MICA-110 exists to stop holding.
    await media.setThumbnail(row.id, thumbnail);
  } catch (e) {
    console.warn(`Media row ${row.id} was drawn but its thumbnail could not be stored.`, e);
  }
};

export const media = {
  ...store,

  /**
   * The whole row, `data` included. What a photo is opened with.
   *
   * Deliberately **not** written back into the window. Caching every opened photo would
   * rebuild the memory footprint this ticket exists to remove — fifty opens is fifty full
   * payloads held for the session — and the caller already has somewhere to put the one
   * row it is looking at. `hydrate` is the exception, and says why.
   */
  full: async (mediaId: number): Promise<MediaItem> =>
    fetchNui<MediaItem>('getMediaItem', { id: mediaId }),

  /**
   * Fetch the bytes for a row that could show a picture and currently has none.
   *
   * **Two different questions, and the predicate asks the right one.** "Has no bytes" is
   * true of every row the list read returns, because the projection strips `data` from all
   * of them. "Could show a picture" is narrower: the row has to be a kind whose bytes are
   * an image (`BYTES_ARE_AN_IMAGE` above) and to have nothing drawable already. Gating on
   * the first would fetch a whole `location` or `audio` payload to draw the placeholder it
   * was already drawing — which it did, on shipped fixture 903, on every gallery open.
   *
   * **Not a legacy path**, whatever the shape of it suggests. `AddMedia` in
   * `server/lib/publicApi.ts` is a published export: it requires `url` *or* `data` and
   * treats `thumbnail` as optional, so any other resource on the server can create a
   * perfectly ordinary photo row with base64 bytes and no thumbnail, today and for as long
   * as that contract stands. The camera writing a thumbnail covers the camera, not the API.
   * Without this those rows draw a grey square in the gallery and in every message they are
   * attached to.
   *
   * Three things keep it from becoming the problem it is fixing. Only rows that could show
   * a picture and have none reach it, so a gallery of camera captures never calls it once.
   * Only rows the player has actually scrolled to are asked for, so the cost tracks what is
   * looked at rather than what is stored. And the queue below serialises them, so a run of
   * such rows streams in one at a time instead of putting twenty-one full-size payloads on
   * the NUI bridge at the same moment.
   *
   * **Paid once in the row's life, not once per session.** The fetched bytes go straight back
   * out through `backfill` above, so the row gains a real `thumbnail`, drops its original
   * from the window, and never reaches this path again. That is the difference between a fix
   * and a workaround: without the write-back an `AddMedia` row would cost its full payload on
   * every single gallery open, forever.
   *
   * Unlike `full`, the result *is* written into the window: the row's only still is its own
   * bytes, so dropping them would mean fetching them again on the next render.
   *
   * Fire-and-forget: a grid tile has nothing useful to do with the promise, and a failure
   * leaves the placeholder standing rather than blanking the tile.
   */
  hydrate: (item: MediaPreview): void => {
    if (!BYTES_ARE_AN_IMAGE.has(item.kind)) return;
    if (item.thumbnail || item.data || item.url) return;
    if (hydrated.has(item.id)) return;

    hydrated.add(item.id);
    queue = queue.then(async () => {
      try {
        const row = await fetchNui<MediaItem>('getMediaItem', { id: item.id });
        if (!row?.data) return;
        store.replace(row);
        await backfill(row);
      } catch (e) {
        console.warn(`Media row ${item.id} has no still and could not be hydrated.`, e);
      }
    });
  },

  /**
   * Take one incoming drop into the window, rather than reloading the library.
   *
   * `media.load()` used to run on every push, so a drop landing while the gallery was open
   * refetched everything the player was already looking at — the second half of what made
   * this app slow. A push is notice that *one* row exists, so this reads the head of the
   * list and prepends what is new: bounded by the page size however many drops arrive, and
   * carrying thumbnails rather than originals like every other read now does.
   *
   * The pushed id short-circuits it entirely when the row is already held, which is the
   * common case for a second push about a photo we have — and the fan-out in
   * `server/services/Media.ts` pushes once per recipient, so duplicates are not
   * theoretical.
   *
   * Not `load()`: that would replace the window and throw away however far the player had
   * paged, to show them a row that belongs at the top of it.
   */
  receive: async (mediaId?: number): Promise<void> => {
    const known = new Set(get(store).map((row) => row.id));
    if (typeof mediaId === 'number' && known.has(mediaId)) return;

    try {
      const reply = await fetchNui<{ rows?: MediaItem[] } | MediaItem[]>('getMedia', {
        limit: PAGE_SIZE
      });
      const rows = Array.isArray(reply) ? reply : (reply?.rows ?? []);
      // Newest-first on the wire, and `prepend` pushes onto the head — so walk it backwards
      // or the new arrivals land in reverse order above rows that are older than they are.
      for (const row of [...rows].reverse()) {
        if (!known.has(row.id)) store.prepend(row);
      }
    } catch (e) {
      console.warn('Media store could not reconcile an incoming drop.', e);
    }
  },

  /**
   * A fresh first page, and a fresh set of rows to hydrate.
   *
   * Clearing `hydrated` is what stops "ask once" from becoming "ask once, ever". The set is
   * a guard against a re-rendering grid, not a record of what the server holds — and the two
   * come apart whenever a write-back does not land: `stored: false`, a `makeThumbnail` that
   * could not decode, a refused request. Such a row arrives blank again on the next load,
   * and without the clear it would stay blank for the rest of the session because its id is
   * already on the list. A row whose write-back *did* land no longer matches the predicate,
   * so clearing costs it nothing.
   */
  load: async (filter?: Record<string, unknown>): Promise<void> => {
    hydrated.clear();
    return store.load(filter);
  },

  /**
   * A fresh capture. Straight onto the head, because the window is `id DESC` and the row
   * the server just echoed back is the newest one there is.
   */
  add: async (
    draft: Omit<MediaItem, 'id' | 'citizenid' | 'created_at' | 'updated_at'>
  ): Promise<MediaItem> => {
    const created = await fetchNui<MediaItem>('createMedia', draft);
    store.prepend(created);
    return created;
  },

  /**
   * Persist a thumbnail the client generated. **One writer, two callers.**
   *
   * `thumbnail` is `clientWritable: false`, so it cannot ride along on the create — this
   * named action is the only way it reaches the column (`server/services/Media.ts`), and
   * both callers are on the client because only the client has a canvas. The camera stores
   * the thumbnail it made at capture; `backfill` above stores one encoded from a row that
   * arrived without, which is the steady-state case `AddMedia`'s optional `thumbnail` keeps
   * producing. They share this rather than each calling the action, so they cannot drift on
   * what success means.
   *
   * Answers `false` rather than throwing when the write does not land. The server's
   * predicate is `thumbnail IS NULL`, ownership-scoped and active-rows-only, so `stored:
   * false` covers "somebody got there first" as much as "not yours" — and two tiles or two
   * sessions racing the same photo is normal, not something to surface.
   *
   * **`data: undefined` on success is the load-bearing half.** Both callers are holding a
   * full base64 original at this moment — the camera from `createMedia`'s echo, the gallery
   * from the row it just hydrated — and those are the heaviest rows in the window. Once the
   * server has a small copy, keeping the big one is holding exactly the memory MICA-110
   * exists to stop holding; the grid redraws from the thumbnail, which is what the next load
   * would have given it anyway.
   */
  setThumbnail: async (mediaId: number, thumbnail: string): Promise<boolean> => {
    const reply = await fetchNui<{ stored?: boolean }>('setMediaThumbnail', {
      id: mediaId,
      thumbnail
    });
    const stored = reply?.stored === true;
    if (stored) {
      const row = get(store).find((item) => item.id === mediaId);
      if (row) store.replace({ ...row, thumbnail, data: undefined });
    }
    return stored;
  },

  delete: async (mediaId: number): Promise<void> => {
    await fetchNui('deleteMedia', { id: mediaId });
    store.remove(mediaId);
  },

  /**
   * Bluetooth proximity drop. Not list/create/update/delete, so it stays a named method
   * rather than stretching the paging factory — the same shape Mail's `archive` uses. The
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
