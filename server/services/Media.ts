import { defineService, SchemaRepository } from '../lib/defineService';
import { MediaItem } from '@shared/types';
import { findNearbyVisiblePlayers } from '../lib/proximity';
import { appEventChannel } from '../lib/appEvents';
import { requirePositiveInt, fields } from '../lib/payload';
import { playerCoords } from '../lib/playerCoords';
import { Database } from '../lib/Database';
import { isAdmin } from './Admin';
import { notifyPlayer } from '../lib/shell';

/**
 * The media table: owner-scoped, create/read/delete only.
 *
 * **The table, the service and the app id are all `media` now.** They were not always in
 * agreement — the table moved off `gphone_photos` first, to `gphone_media`, while the
 * service/app id stayed `photos` because an id is a key: it is the directory name, the
 * per-app storage namespace, the `<app>` segment of every event, the `?app=` deep link and
 * the launcher label, so renaming it is a bigger change than renaming a table (§11.1). That
 * gap is what this second pass closes — the id finishing the same rename the table already
 * made, rather than three names for one thing settling into two.
 *
 * (That namespace is spelled out in words rather than as a literal on purpose:
 * `eventNames.test.ts` scans source for event-shaped string literals and cannot tell prose
 * from a real name, so writing one here reads as a malformed event.)
 *
 * The table rename was a **consequence** of needing more than one storage shape, not a
 * tidying exercise. The old table had exactly one payload column, `image mediumtext`
 * holding base64, which can only ever be a photo — and that is what blocked voice clips,
 * video with a poster frame, GIFs by URL, RCS-style file transfer, link previews and now a
 * shared location.
 *
 * `data` rather than `image` for the same reason: the column holds base64 audio and video
 * too, and the old name would be a lie the moment the table earned its own. It is also
 * **nullable** now, where `image` was `notNull` — a `link` or a hotlinked `gif` row has a
 * `url` and no bytes at all.
 *
 * `update` stays closed. Stored media has no mutable fields, so an update endpoint would
 * be dead surface. `get` and `delete` come from the generic path: get filters to
 * status = 'active', and delete is an ownership-scoped soft delete that writes the audit
 * entry.
 */
export const media = defineService<MediaItem>({
  id: 'media',
  table: 'gphone_media',
  reportable: { label: 'Photo', previewColumn: 'data' },
  access: { read: 'owner', write: 'owner' },
  statuses: ['active', 'deleted', 'moderated'],
  schema: {
    /**
     * Deliberately over-provisioned, and this is the one decision here that cannot be
     * deferred. `SchemaMigrator` is additive-only: widening an enum is a type change, so
     * it is printed for a human and never applied (§8). Every value left out now costs a
     * second hand-written migration against a bigger table, so they all go in at once
     * even though this pass writes only `photo`.
     */
    kind: {
      type: 'enum',
      values: ['photo', 'video', 'audio', 'gif', 'sticker', 'file', 'link', 'location'],
      notNull: true,
      default: 'photo'
    },
    /**
     * Base64 for locally captured media. Was `image`.
     *
     * `kind` and `data` are the only two columns a client may write, and every other one
     * is `clientWritable: false` — not because they are dangerous today but because
     * nothing writes them today. A column the client can set before any feature needs it
     * is surface with no caller to constrain it (§2.9). Flip one when the feature that
     * fills it arrives, which is a one-line, reviewable change.
     *
     * **`private: true` is a read-projection decision and changes nothing about writes**
     * (MICA-110). `data` stays client-writable, because the camera creating a photo is
     * exactly the caller that fills it. What it stops is the *list*: the generic `get`
     * used to hand back every column, so drawing a grid of 123px tiles downloaded every
     * original at full size — a few hundred kilobytes a row, tens of megabytes for a real
     * library, every time the app came to the foreground. The full bytes are still the
     * owner's to read; they come from the `item` action below, one row at a time, when a
     * photo is actually opened.
     */
    data: { type: 'mediumtext', private: true },
    /** Hotlinks — a remote GIF or video that is not ours to store. */
    url: { type: 'string', length: 512, clientWritable: false },
    /** Poster frame for video and GIF, so a feed has something before the media loads. */
    thumbnail: { type: 'mediumtext', clientWritable: false },
    mime_type: { type: 'string', length: 64, clientWritable: false },
    /** Reserve layout space, so a feed does not reflow as media arrives. */
    width: { type: 'int', clientWritable: false },
    height: { type: 'int', clientWritable: false },
    duration_ms: { type: 'int', clientWritable: false },
    byte_size: { type: 'int', clientWritable: false },
    /** Accessibility, and what RCS carries alongside an attachment. */
    alt_text: { type: 'string', length: 255, clientWritable: false }
  },
  indexes: [{ name: 'citizenid_status_created', columns: ['citizenid', 'status', 'created_at'] }],
  /**
   * Keyset on `id DESC`, like every other paged read here (§10).
   *
   * `read: 'owner'` does not *require* paging the way `read: 'public'` does — the ownership
   * predicate already bounds the result to one player's rows — which is why this table never
   * had it. That bound is a bound on whose rows, though, not on how many or how big, and a
   * gallery is the one owner-scoped table where a single player's own list is unbounded and
   * every row is heavy. Thirty thumbnails is a few screens of grid; sixty is the most a
   * client may ask for at once.
   *
   * Note for the caller: declaring paging changes the generic `get` reply from a bare array
   * to `{ rows, nextCursor }`, with `nextCursor: null` meaning end-of-list.
   */
  paging: { pageSize: 30, maxPageSize: 60 },
  options: { disableUpdate: true },
  /**
   * Depending on driver and column type, a `mediumtext` can come back as a Buffer — which
   * would cross NUI as `{type:'Buffer',data:[...]}` and render as nothing. Coerced to a
   * string on the way out.
   *
   * `thumbnail` is coerced alongside `data` because it is the same column type and would
   * fail the same way; it is empty today, so this is the cheapest moment to get it right.
   */
  repositoryFactory: (resolved) =>
    new (class extends SchemaRepository<MediaItem> {
      /**
       * Write a row on a player's behalf, from the server.
       *
       * A **named** method rather than a service-level bypass (§2.9): the columns it sets
       * are `clientWritable: false` precisely so no payload can reach them, and the way
       * to write one anyway is a method that says what it is for. The only caller is the
       * `AddMedia` export, which is how an external resource gets a GIF, a video poster
       * or a voice clip into a player's gallery — the camera can only ever produce a
       * `photo`.
       */
      async addForPlayer(citizenid: string, item: Partial<MediaItem>): Promise<number> {
        return await this.create({ ...item, citizenid } as Partial<MediaItem>);
      }

      /**
       * **Forwards `page` and `projection`, and that is the whole point of the signature.**
       *
       * This override took `where` alone until MICA-110, which was harmless only while
       * the service declared neither paging nor a private column: `ServiceEndpoint` passes
       * both positionally, and a narrower override drops them on the floor. Silently — the
       * read still answers, with every column and every row, so the symptom is not an error
       * but the exact cost this ticket exists to remove.
       */
      async findAll(
        where: Partial<MediaItem> = {},
        page?: { limit?: number; cursor?: number },
        projection?: readonly string[]
      ): Promise<MediaItem[]> {
        return (await super.findAll(where, page, projection)).map(coerceBinaryText);
      }

      /**
       * Persist a thumbnail for one of the caller's own rows that has none.
       *
       * **Not the cancelled backfill.** Two different things wore that word: a migration
       * writing thumbnails onto legacy photos, which the owner cancelled because no legacy
       * rows will exist; and this, which is how a thumbnail reaches the column *at all*
       * after the fact. `AddMedia` (`lib/publicApi.ts`) is a published export whose
       * `thumbnail` is optional, so other resources will keep creating thumbnail-less photo
       * rows indefinitely — and without this every one of them is re-fetched at full size on
       * every gallery open, forever, which is the exact cost MICA-110 exists to remove.
       *
       * A **named** method over hand-written SQL rather than `update`, for three predicates
       * the generic path has no way to express (§2.9):
       *
       * - `citizenid` — ownership, the same rule every other write here obeys. A row id is
       *   never authorization.
       * - `status = 'active'` — a moderated or deleted row is not something an owner gets to
       *   keep touching, and `findById` scopes by owner but not by status.
       * - **`thumbnail IS NULL` — write-once.** The column is `clientWritable: false` and
       *   stays so; this is the one door to it, and it opens only for a row that has none.
       *   So it cannot be replayed to rewrite a thumbnail, and cannot grow a row that
       *   already has one.
       *
       * The column names are literals in this file, never payload keys, so there is no
       * identifier to check against an allowlist — only the three bound values.
       */
      async storeThumbnail(id: number, citizenid: string, thumbnail: string): Promise<boolean> {
        return await Database.update(
          `UPDATE \`${this.tableName}\` SET \`thumbnail\` = ? ` +
            "WHERE `id` = ? AND `citizenid` = ? AND `status` = 'active' AND `thumbnail` IS NULL",
          [thumbnail, id, citizenid]
        );
      }

      async findById(id: number | string, citizenid?: string): Promise<MediaItem | null> {
        const row = await super.findById(id, citizenid);
        return row ? coerceBinaryText(row) : null;
      }
    })(resolved)
});

const coerceBinaryText = (item: MediaItem): MediaItem => {
  if (item.data && typeof item.data !== 'string') {
    item.data = (item.data as any).toString('utf8');
  }
  if (item.thumbnail && typeof item.thumbnail !== 'string') {
    item.thumbnail = (item.thumbnail as any).toString('utf8');
  }
  return item;
};

const app = media.app;
const repo = media.repo;

/**
 * The bytes for exactly one row the caller owns. MICA-110.
 *
 * The other half of `data`'s `private: true`. The list read draws a grid and needs nothing
 * bigger than a thumbnail; opening a photo needs the original, and that is one row rather
 * than the whole library — so it is one action, taking one id, rather than a flag on the
 * list that would hand back everything again.
 *
 * Ownership-scoped exactly like `drop` below, and the status check is there for exactly the
 * same reason: `findById` is the primitive `findById(id, citizenid?)`, which scopes by owner
 * and knows nothing about this table's moderation state. Without the explicit check, a photo
 * a moderator had pulled from every list would still be readable in full by anyone who had
 * seen its id — which is the entire thing moderating it was for.
 *
 * The error text is the same sentence a missing row and a row belonging to somebody else
 * both get, deliberately: distinguishing them would answer "does this id exist" for ids the
 * caller does not own.
 */
app.registerEvent('item', async (_source, _cbId, data, citizenid) => {
  const raw = data && typeof data === 'object' ? fields(data).id : data;
  const id = requirePositiveInt(raw, 'media id');

  const row = await repo.findById(id, citizenid);
  if (!row || row.status !== 'active') throw new Error('That photo could not be found.');

  return row;
});

/**
 * The largest thumbnail this will accept, as a base64 data URI.
 *
 * A thumbnail is a few hundred pixels on its longest edge — ten to twenty kilobytes encoded,
 * a third more again as base64 — so 64KB is several times the honest size and still an order
 * of magnitude under the originals this ticket exists to stop shipping. The cap is what stops
 * store-back becoming a second way to store a full-size photo: without it a client could
 * "thumbnail" a row with its own original and reintroduce the whole problem through the door
 * built to close it.
 *
 * Checked here rather than left to the column, because `mediumtext` holds 16MB and would
 * accept every one of them.
 */
const MAX_THUMBNAIL_LENGTH = 64 * 1024;

/**
 * `data:image/` only — deliberately narrower than `publicApi.ts`'s `SAFE_URL`.
 *
 * That one also permits `http(s):`, which is right for `AddMedia`: a resource hotlinking a
 * poster frame it hosts is a legitimate row. It is not right here. This action exists for a
 * client persisting bytes it encoded locally, so a remote URL is never the honest answer —
 * and storing one would point a gallery tile at a third-party host that the phone then
 * requests on every render, which is a beacon rather than a thumbnail.
 */
const THUMBNAIL_DATA_URI = /^data:image\//i;

/**
 * Store a thumbnail a client generated for a row that had none. MICA-110.
 *
 * The server cannot do this work itself: the FiveM server runtime has no canvas, and giving
 * it one means an image codec as a **runtime** dependency shipped to every server owner
 * (§2.5) — native binaries per platform for `sharp`, or `jimp`, which cannot decode the WebP
 * this codebase actually produces. It would also put a synchronous decode of a few hundred
 * kilobytes on the server tick per call. The client already has a GPU-backed canvas and is
 * where the work belongs; this is only how the result is kept.
 *
 * `thumbnail` stays `clientWritable: false`. This is not the generic write path and does not
 * reopen it — every predicate that makes the write safe is in `storeThumbnail`'s single
 * statement, so there is no gap between deciding and writing.
 *
 * Answers `{ stored }` rather than throwing when the row already has one. Two tiles, two
 * sessions and the same photo race by nature, and "somebody got there first" is a normal
 * outcome rather than a failure a player should be told about.
 */
app.registerEvent('thumbnail', async (_source, _cbId, data, citizenid) => {
  const body = fields(data);
  const id = requirePositiveInt(body.id, 'media id');

  const thumbnail = body.thumbnail;
  if (typeof thumbnail !== 'string' || !THUMBNAIL_DATA_URI.test(thumbnail.trim())) {
    throw new Error('A thumbnail must be an image data URI.');
  }
  if (thumbnail.length > MAX_THUMBNAIL_LENGTH) {
    throw new Error('That thumbnail is too large.');
  }

  const privileged = repo as unknown as {
    storeThumbnail(id: number, citizenid: string, thumbnail: string): Promise<boolean>;
  };
  return { stored: await privileged.storeThumbnail(id, citizenid, thumbnail) };
});

/**
 * Bluetooth proximity drop: copy one of the caller's own media rows to everyone nearby
 * and Bluetooth-visible.
 *
 * A custom `registerEvent` action rather than a raw `onNet` handler — reached through the
 * named `shareMediaNearby` route (`shared/routes.ts`), so `ServiceEndpoint`'s own rate
 * limiting and citizenid resolution already cover it, and its return value becomes the
 * NUI response directly (§10's `BlabberDms.ts` `send` action is the worked example of
 * this shape).
 *
 * `findById(mediaId, citizenid)` is the ownership check (§2.9) — a `mediaId` naming a row
 * the caller does not own resolves to `null` and the whole request is refused before
 * anything nearby is even computed. Each recipient gets a **copy**, not a shared
 * reference: gPhone's gallery is owned per player, and the sender deleting their photo
 * later must not delete anyone else's.
 *
 * `findById` scopes by owner but not by `status` — it is the primitive `findById(id,
 * citizenid?)` on `Repository`, and nothing about it knows this table has a moderation
 * state. Without the explicit check below, a photo a moderator had already pulled from
 * every read (`status = 'moderated'`) — or one its own owner had deleted — was still
 * reachable by its id and would go right back out to nearby players, the same hole
 * `access.editWindow`'s `status != 'moderated'` predicate closes on the write side.
 */
app.registerEvent('drop', async (source, _cbId, data, citizenid) => {
  const mediaId = requirePositiveInt(fields(data).mediaId, 'mediaId');

  const owned = await repo.findById(mediaId, citizenid);
  if (!owned || owned.status !== 'active') throw new Error('That photo could not be found.');

  const nearby = await findNearbyVisiblePlayers(source, citizenid);

  let count = 0;
  for (const target of nearby) {
    await repo.create({
      citizenid: target.citizenid,
      kind: owned.kind,
      data: owned.data,
      url: owned.url,
      thumbnail: owned.thumbnail,
      mime_type: owned.mime_type,
      width: owned.width,
      height: owned.height,
      duration_ms: owned.duration_ms,
      byte_size: owned.byte_size,
      alt_text: owned.alt_text
    } as Partial<MediaItem>);
    count += 1;

    const outcome = appEventChannel('media').push(
      target.citizenid,
      'media_received',
      {},
      {
        notify: { title: 'Media received', message: 'A nearby phone sent you a photo.' }
      }
    );
    if (!outcome.delivered && outcome.reason !== 'offline') {
      console.error(
        `[media] mediaReceived push to ${target.citizenid} was refused: ${outcome.reason}.`
      );
    }
  }

  return { count };
});

/**
 * Share the caller's current in-game position as a message attachment.
 *
 * The coordinates never come from `data` — only `playerCoords(source)` does, the same
 * guarded `GetPlayerPed`/`DoesEntityExist`/`GetEntityCoords` read `Signal.ts` and
 * `proximity.ts` already trust for a player's live position. A client-reported
 * coordinate would be exactly the failure the roadmap's Battery correction already named:
 * a value with real stakes (this is what a recipient's waypoint points at) accepted from
 * self-report instead of read independently.
 *
 * `label` is the one thing actually trusted from the payload, and deliberately: the
 * street name it names can only be resolved by a client-only native
 * (`GetStreetNameAtCoord`/`GetStreetNameFromHashKey` do not exist server-side), so it is
 * resolved on the sender's own client and carried here as cosmetic display text — the
 * same trust level as a contact name or a message body, never as anything the waypoint's
 * actual target depends on. Bounded to `alt_text`'s own 255-char column length here,
 * since a custom action is not covered by `assertWritableValue`'s per-column rules the
 * way generic CRUD is.
 *
 * `addForPlayer` (the same privileged bypass `AddMedia` uses) rather than the ordinary
 * client-writable path, because `data` and `alt_text` here are both server-determined —
 * a location row's `data` is never something the client itself should be free to set.
 */
app.registerEvent('shareLocation', async (source, _cbId, data, citizenid) => {
  const rawLabel = fields(data).label;
  const label =
    typeof rawLabel === 'string' && rawLabel.trim() ? rawLabel.trim().slice(0, 255) : undefined;

  const coords = playerCoords(source);
  if (!coords) throw new Error('Could not determine your location.');
  const [x, y, z] = coords;

  const privileged = repo as unknown as {
    addForPlayer(citizenid: string, item: Partial<MediaItem>): Promise<number>;
  };
  const id = await privileged.addForPlayer(citizenid, {
    kind: 'location',
    data: JSON.stringify({ x, y, z }),
    alt_text: label
  } as Partial<MediaItem>);

  return { id, media: await repo.findById(id, citizenid) };
});

interface MediaTotalsRow {
  rowCount: number | string | null;
  totalBytes: number | string | null;
}

interface MediaHolderRow {
  citizenid: string;
  rowCount: number | string;
  bytes: number | string | null;
}

export interface MediaStorageStats {
  rowCount: number;
  totalBytes: number;
  topHolders: { citizenid: string; rowCount: number; bytes: number }[];
}

const TOP_HOLDER_COUNT = 10;

/**
 * MICA-71 step 1: measure before anything else. `byte_size` (the column) is never
 * written by anything today, so it cannot answer this — the real size lives in `data` and
 * `thumbnail` themselves, measured directly. Every row counts, not just `status = 'active'`
 * ones: a soft delete leaves the payload columns in place, so a deleted or moderated row
 * still costs exactly as many bytes as a live one until something actually purges it.
 */
export const mediaStorageStats = async (): Promise<MediaStorageStats> => {
  const totals = await Database.single<MediaTotalsRow>(
    `SELECT COUNT(*) AS rowCount,
            SUM(IFNULL(LENGTH(data), 0) + IFNULL(LENGTH(thumbnail), 0)) AS totalBytes
     FROM gphone_media`
  );

  const holders = await Database.query<MediaHolderRow[]>(
    `SELECT citizenid,
            COUNT(*) AS rowCount,
            SUM(IFNULL(LENGTH(data), 0) + IFNULL(LENGTH(thumbnail), 0)) AS bytes
     FROM gphone_media
     GROUP BY citizenid
     ORDER BY bytes DESC
     LIMIT ${TOP_HOLDER_COUNT}`
  );

  return {
    rowCount: Number(totals?.rowCount ?? 0),
    totalBytes: Number(totals?.totalBytes ?? 0),
    topHolders: (holders ?? []).map((h) => ({
      citizenid: h.citizenid,
      rowCount: Number(h.rowCount),
      bytes: Number(h.bytes ?? 0)
    }))
  };
};

const formatBytes = (bytes: number): string => {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)}${units[unit]}`;
};

/**
 * `gphonemedia` — report-only, same shape as `gphoneschema` without an `apply` half:
 * nothing here writes anything. Console and any `isAdmin` caller both get the full
 * breakdown in the server console (a top-10 list does not fit a toast), plus a one-line
 * toast for whoever ran it in-game so they know it actually did something.
 */
export const runMediaStatsCommand = async (source: number): Promise<void> => {
  if (!isAdmin(source)) {
    notifyPlayer(source, {
      type: 'error',
      message: 'You do not have permission to use that.'
    });
    return;
  }

  const stats = await mediaStorageStats();

  console.log(
    `[gphonemedia] ${stats.rowCount} row(s), ${formatBytes(stats.totalBytes)} total ` +
      `(${stats.totalBytes} bytes) in gphone_media.`
  );
  if (stats.topHolders.length > 0) {
    console.log(`[gphonemedia] top ${stats.topHolders.length} by size:`);
    for (const holder of stats.topHolders) {
      console.log(
        `[gphonemedia]   ${holder.citizenid}: ${holder.rowCount} row(s), ` +
          `${formatBytes(holder.bytes)} (${holder.bytes} bytes)`
      );
    }
  }

  if (source !== 0) {
    notifyPlayer(source, {
      type: 'success',
      message: `gphone_media: ${stats.rowCount} rows, ${formatBytes(stats.totalBytes)} — see server console for the breakdown.`
    });
  }
};

RegisterCommand(
  'gphonemedia',
  (source: number) => {
    void runMediaStatsCommand(source).catch((error) => {
      console.error('[gphonemedia] failed:', error);
    });
  },
  false
);
