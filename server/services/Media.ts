// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PlayerFacingError } from '../lib/errors';
import { defineService } from '../lib/defineService';
import { MediaItem } from '@mica/shared/types';
import { findNearbyVisiblePlayers } from '../lib/proximity';
import { appEventChannel } from '../lib/appEvents';
import { mediaContract } from '@mica/shared/contracts/media';
import { playerCoords } from '../lib/playerCoords';
import { Database } from '../lib/Database';
import { whenSchemaReady } from '../lib/schemaReady';
import { purgeOwnedRows, registerOwnedExternal, sweepOrphanedRows } from '../lib/orphanSweep';
import { isAdmin } from './Admin';
import { notifyPlayer } from '../lib/shell';
import { restoreWindowDays } from '../lib/retention';
import { isRetentionRunning, pruneTable, registerRetention } from '../lib/contentRetention';
import { imageHost, releaseHostedImages, rememberImageHost, reportRelease } from '../lib/mediaHost';
import { MediaRepository } from '../lib/media/repository';
import { formatBytes, mediaStorageStats } from '../lib/media/stats';
import { logMediaLimits, retentionDays } from '../lib/media/limits';

export {
  NOMINAL_HOSTED_BYTES,
  hostedUrlPrefixes,
  quotaBytes,
  storedBytesOf,
  usedBytesQuery
} from '../lib/media/quota';
export { mediaStorageStats } from '../lib/media/stats';

/**
 * The media table: owner-scoped, create/read/delete only.
 *
 * **The table, the service and the app id are all `media` now.** They were not always in
 * agreement — the table moved off `mica_photos` first, to `mica_media`, while the
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

/**
 * The rest of what this file used to hold lives in `lib/media/`, none of it registering
 * anything: `quota.ts` (the per-row cap and the per-player quota), `hosting.ts` (MICA-71 and
 * the image host), `repository.ts` (the class `repositoryFactory` builds), `stats.ts` (what
 * `micamedia` reports) and `limits.ts` (the resolved convars). Everything that registers —
 * the declaration, the actions, the hard deletes, the commands, the start-up sweep — is here.
 */

export const media = defineService<MediaItem, typeof mediaContract>({
  id: 'media',
  contract: mediaContract,
  table: 'mica_media',
  deviceOwned: true,
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
  indexes: [
    { name: 'citizenid_status_created', columns: ['citizenid', 'status', 'created_at'] },
    // The retention prune's walk (MICA-167): oldest first across every owner. Additive.
    { name: 'created_at', columns: ['created_at'] }
  ],
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
  repositoryFactory: (resolved) => new MediaRepository(resolved)
});

const app = media.app;
const repo = media.repo;

/**
 * Undo a `delete`, within `restoreWindowDays()` of it (MICA-75) — see
 * `Repository.restore` for the ownership scoping and why `updated_at` stands in for a
 * deletion timestamp. Not to be confused with `drop` below, which shares a photo to
 * nearby phones and has nothing to do with this row's own `status`.
 */
// Every handler below is scoped to the phone in the caller's hand as well as to them
// (MICA-282). The phone id is always present on a device-owned service — the endpoint
// refused the request otherwise — and the casts say so where the type cannot.
app.registerEvent('restore', async (_source, _cbId, data, citizenid, _player, phoneId) => {
  const ok = await repo.restore(data.id, citizenid, restoreWindowDays(), phoneId);
  return { ok };
});

/**
 * The "Recently Deleted" list itself (MICA-75-wiring) — every media row `restore` above
 * could still bring back. See `Repository.findDeleted` for why this is a named action
 * rather than the generic `get`. Projected the same way the main list is (MICA-110):
 * no `data`, so a deleted row full of base64 bytes does not cost its whole payload just to
 * appear in a list that only needs a caption and a small still.
 */
app.registerEvent('getDeleted', async (_source, _cbId, _data, citizenid, _player, phoneId) => {
  return await repo.findDeleted(
    citizenid,
    restoreWindowDays(),
    ['id', 'kind', 'thumbnail', 'mime_type', 'alt_text', 'created_at', 'updated_at'],
    phoneId
  );
});

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
app.registerEvent('item', async (_source, _cbId, data, citizenid, _player, phoneId) => {
  const row = await repo.findById(data.id, citizenid, phoneId);
  if (!row || row.status !== 'active')
    throw new PlayerFacingError('That photo could not be found.', {
      key: 'server.media.notFound'
    });

  return row;
});

/**
 * What a thumbnail may be — the 64KB cap and the `data:image/` prefix — is declared in
 * `shared/contracts/media.ts` and enforced before this handler runs.
 *
 * Both rules were written here as a length check and a regex, and both are the kind of rule
 * that only exists where somebody remembered to write it. The cap is what stops store-back
 * becoming a second way to keep a full-size photo: without it a client could "thumbnail" a row
 * with its own original and reintroduce the whole problem through the door built to close it.
 * A thumbnail is a few hundred pixels on its longest edge, so 64KB is several times the honest
 * size and still an order of magnitude under the originals. `mediumtext` holds 16MB and would
 * accept every one of them, which is why the bound cannot come from the column.
 *
 * `data:image/` only, deliberately narrower than `publicApi.ts`'s `SAFE_URL`. That one also
 * permits `http(s):`, which is right for `AddMedia` — a resource hotlinking a poster frame it
 * hosts is a legitimate row. It is not right here: this action exists for a client persisting
 * bytes it encoded locally, so a remote URL is never the honest answer, and storing one would
 * point a gallery tile at a third-party host the phone then requests on every render, which is
 * a beacon rather than a thumbnail.
 */

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
app.registerEvent('thumbnail', async (_source, _cbId, data, citizenid, _player, phoneId) => {
  const privileged = repo as unknown as {
    storeThumbnail(
      id: number,
      citizenid: string,
      phoneId: string,
      thumbnail: string
    ): Promise<boolean>;
  };
  return {
    stored: await privileged.storeThumbnail(data.id, citizenid, phoneId as string, data.thumbnail)
  };
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
 * reference: micaOS's gallery is owned per player, and the sender deleting their photo
 * later must not delete anyone else's.
 *
 * `findById` scopes by owner but not by `status` — it is the primitive `findById(id,
 * citizenid?)` on `Repository`, and nothing about it knows this table has a moderation
 * state. Without the explicit check below, a photo a moderator had already pulled from
 * every read (`status = 'moderated'`) — or one its own owner had deleted — was still
 * reachable by its id and would go right back out to nearby players, the same hole
 * `access.editWindow`'s `status != 'moderated'` predicate closes on the write side.
 */
app.registerEvent('drop', async (source, _cbId, data, citizenid, _player, phoneId) => {
  const owned = await repo.findById(data.mediaId, citizenid, phoneId);
  if (!owned || owned.status !== 'active')
    throw new PlayerFacingError('That photo could not be found.', {
      key: 'server.media.notFound'
    });

  const nearby = await findNearbyVisiblePlayers(source, citizenid);
  // One person, not one phone: two sources resolving to the same character is one copy and
  // one toast, and `pushMany` deduplicates its own side regardless.
  const nearbyCitizenids = [...new Set(nearby.map((target) => target.citizenid))];
  if (nearbyCitizenids.length === 0) return { count: 0 };

  /**
   * A drop writes each recipient a **full copy**, so it is the one path where one tap
   * multiplies stored bytes — and a bystander whose own library is already at its ceiling
   * must not be pushed over it by somebody else's gesture (MICA-71).
   *
   * The ceiling is enforced *inside* each insert now rather than measured for the group
   * first (MICA-131), so `copyToPlayers` is the only thing that decides who got a copy
   * and this handler has no second opinion to disagree with it. That is also why the push
   * below fans out to what came back rather than to `nearbyCitizenids`: a bystander with
   * no room gets neither a row nor a toast about one.
   *
   * `owned` is only what this handler read before it looked for anyone nearby; the copy is
   * selected from the sender's row as it stands then (MICA-293), so a row retention deleted
   * in the meantime — and whose file it released — is copied to nobody.
   */
  const privileged = repo as unknown as {
    copyToPlayers(citizenids: readonly string[], source: MediaItem): Promise<string[]>;
  };
  const recipients = await privileged.copyToPlayers(nearbyCitizenids, owned);
  if (recipients.length === 0) return { count: 0 };
  const count = recipients.length;

  /**
   * `pushMany` rather than a `push` per recipient, and it is not a loop around one (§8):
   * it takes a single `getAllPlayers()` snapshot for the whole fan-out instead of walking
   * the player list once per bystander.
   *
   * The rows are already committed, so a refused notification is logged rather than thrown
   * — telling a sender their share failed when every copy landed is the worse answer.
   */
  const { delivered, offline } = appEventChannel('media').pushMany(
    recipients,
    'media_received',
    {},
    {
      notify: { title: 'Media received', message: 'A nearby phone sent you a photo.' }
    }
  );
  const accounted = new Set([...delivered, ...offline]);
  for (const recipient of recipients) {
    if (!accounted.has(recipient)) {
      console.error(`[media] mediaReceived push to ${recipient} was refused.`);
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
app.registerEvent('shareLocation', async (source, _cbId, data, citizenid, _player, phoneId) => {
  const label = data.label?.trim() || undefined;

  const coords = playerCoords(source);
  if (!coords)
    throw new PlayerFacingError('Could not determine your location.', {
      key: 'server.media.noLocation'
    });
  const [x, y, z] = coords;

  const privileged = repo as unknown as {
    addForPlayer(citizenid: string, item: Partial<MediaItem>): Promise<number>;
  };
  const id = await privileged.addForPlayer(citizenid, {
    kind: 'location',
    data: JSON.stringify({ x, y, z }),
    alt_text: label,
    // The phone in hand, rather than the one `addForPlayer` would resolve for the citizen.
    phone_id: phoneId
  } as Partial<MediaItem>);

  return { id, media: await repo.findById(id, citizenid, phoneId) };
});

/**
 * The URLs on the `mica_media` rows `where` selects (row alias `t`), read **before** those rows
 * are deleted, for `releaseHosted` after. MICA-243, and the one collector every hard-delete
 * path shares since MICA-292: retention, both character purges and the orphan sweep.
 *
 * Every URL, not only the current host's. `releaseHostedImages` is what decides which are
 * ours — the current host's to delete, a former host's to count — and a hotlink it ignores.
 * Filtering here with `validateHostedUrl` is what made an old host's photos vanish from the count
 * once an owner changed `mica_media_image_host`.
 *
 * `where` is SQL this file or `lib/orphanSweep.ts` built from declared identifiers; every
 * value in it is bound.
 */
const collectMediaUrls = async (
  where: { sql: string; params: readonly unknown[] },
  limit: number
): Promise<string[]> => {
  const rows = await Database.query<{ url: unknown }[]>(
    `SELECT DISTINCT t.\`url\` FROM \`${media.resolved.table}\` t ` +
      `WHERE t.\`url\` IS NOT NULL AND ${where.sql} LIMIT ${Math.max(1, Math.floor(limit))}`,
    [...where.params]
  );
  return (Array.isArray(rows) ? rows : [])
    .map((row) => row.url)
    .filter((url): url is string => typeof url === 'string' && url !== '');
};

/** What retention collects for a batch of ids. */
const urlsOfIds = async (ids: readonly number[]): Promise<string[]> =>
  ids.length === 0
    ? []
    : await collectMediaUrls(
        { sql: `t.\`id\` IN (${ids.map(() => '?').join(', ')})`, params: ids },
        ids.length
      );

/** Ask the host to delete what the deleted rows named, and say what happened. */
const releaseHosted = async (urls: readonly string[]): Promise<void> => {
  reportRelease('micamedia', await releaseHostedImages(urls));
};

/**
 * The orphan sweep and the whole-phone purge (`lib/orphanSweep.ts`) delete media rows too,
 * and without this they deleted the rows and left the files: a deleted character's photos
 * stayed publicly reachable at their URLs. MICA-292.
 */
registerOwnedExternal(media.resolved.table, { collect: collectMediaUrls, release: releaseHosted });

const mediaRetention = {
  label: 'micamedia',
  table: media.resolved.table,
  convar: 'mica_media_retention',
  days: retentionDays,
  // A hosted photo's file goes with its row, or is reported as left behind (MICA-243).
  external: { collect: urlsOfIds, release: releaseHosted }
};
registerRetention(mediaRetention);

/**
 * Delete every media row older than the retention window. **A hard delete of the bytes**:
 * media is stored in-row (`data`, `thumbnail`), so removing the row is removing the photo.
 * The exception is a photo on an image host (MICA-243): its file is deleted through
 * `mica_media_delete_url` once no row names it, or counted and reported as left there when
 * that is not set.
 *
 * Worth being exact about, because the word means two different things in this schema
 * (MICA-75): a player deleting a photo writes `status = 'deleted'` and the row keeps
 * every byte it had, which is why a soft delete reclaims nothing and why this exists. This
 * removes the row.
 *
 * `created_at` rather than `updated_at`, and every status, with two holds: media is never
 * removed while an open report names it, or while a live message, blab or listing still has it
 * attached — a year-old photo on this morning's message stays as long as the message does.
 * The batching, the report hold and the attachment rows are `lib/contentRetention.ts`'s; this
 * is the same prune the six-hourly schedule runs, reachable on its own for `micamedia prune`.
 */
export const pruneExpiredMedia = async (): Promise<number> => await pruneTable(mediaRetention);

/**
 * Delete media whose owner no longer exists. **A hard delete, and the character-deletion
 * cleanup.**
 *
 * Since MICA-300 this, with the whole-phone sweep at every start, *is* the cleanup: no
 * framework's schema cascades into `mica_media` any more. On qb it used to — every table
 * carried `FOREIGN KEY (citizenid) REFERENCES players (citizenid) ON DELETE CASCADE`, and a
 * deleted character's photos went inside MariaDB before a report hold could keep one or a
 * hosted file could be released. Migration 0006 dropped that key, so the rows stay until
 * this decides, keeping a photo under an open report and one an attachment still names.
 *
 * **The safety argument now lives in `lib/orphanSweep.ts`** — the framework verdict, the
 * owner-table count, the sampled identity check, and the rule that anything unconfirmed
 * leaves the table alone and says so. Read that file before changing this one. Restating a
 * single table's worth of that reasoning here is how the two copies drift, and the copy
 * that drifts is the one that deletes.
 *
 * Still its own function, because `micamedia prune` reports media separately from
 * everything else and because this is the sweep the README told operators about.
 */
export const pruneOrphanedMedia = async (): Promise<number> => {
  const { removed } = await sweepOrphanedRows({
    only: [{ table: media.resolved.table, column: 'citizenid' }],
    label: 'micamedia'
  });
  return removed;
};

/**
 * Remove one character's media. **A hard delete**, by the plan the other deletes use.
 *
 * The immediate half of the cleanup above: a deletion flow that calls this reclaims the
 * bytes at once instead of waiting for the next restart's sweep.
 *
 * It used to be a bare `DELETE FROM mica_media WHERE citizenid = ?`, and every attachment row
 * naming one of those photos went with it by `ON DELETE CASCADE` — the photo on a reported
 * message took the attachment with it, hold or no hold (MICA-300). It is `purgeOwnedRows` now,
 * restricted to `mica_media`: a photo under an open report stays, and so does a photo any
 * attachment still names, since this purge never deletes from another table and the plan will
 * not cascade into one. Those go with the character-deleted purge or the orphan sweep. What the
 * deleted rows named on an image host is released as they go (MICA-292).
 *
 * Rejects when the purge could not finish, so the caller says so; each failure is logged
 * where it happened.
 */
export const purgeMediaForCitizen = async (citizenid: string): Promise<number> => {
  const owner = typeof citizenid === 'string' ? citizenid.trim() : '';
  if (owner.length === 0) return 0;

  const { removed, failures } = await purgeOwnedRows(owner, {
    only: [{ table: media.resolved.table, column: 'citizenid' }],
    purpose: 'for the media-only purge'
  });
  if (failures.length > 0) {
    throw new Error(`removed ${removed} row(s), then failed on ${media.resolved.table}.`);
  }
  return removed;
};

/**
 * Told that a character is gone, purge its media.
 *
 * **`on`, never `onNet`, and the distinction is the security boundary.** `onNet` would
 * register this as a net event, and a registered net event is reachable by a modified
 * client (§2.9) — which would hand any player a one-argument delete of any other player's
 * entire gallery. `on` registers a local handler only, so the sole way to reach it is a
 * trigger from another **server** resource, which is code the owner installed.
 *
 * micaOS owns the name rather than listening for a framework's, deliberately. qb-core and
 * qbx_core do not agree on what they emit when a character is deleted, and several
 * multicharacter resources emit nothing at all — registering a handler for a guessed name
 * would be cleanup that silently never runs, which reads exactly like cleanup that works.
 * A name a server owner wires up on purpose either fires or visibly does not, and the orphan
 * sweep at every start (`pruneOrphanedMedia` for media alone) covers the owner who wires up
 * nothing.
 */
on('mica:server:media:characterDeleted', (rawCitizenid: unknown) => {
  const citizenid = typeof rawCitizenid === 'string' ? rawCitizenid.trim() : '';
  if (citizenid.length === 0) return;

  void purgeMediaForCitizen(citizenid)
    .then((removed) => {
      // Unconditionally, including zero: the reason `lib/shell.ts` gives for its own hook.
      console.log(`[micamedia] purged ${removed} row(s) for deleted character ${citizenid}.`);
    })
    .catch((error) => {
      console.error('[micamedia] purge for a deleted character failed:', error);
    });
});

/**
 * Both sweeps together, as `micamedia prune` runs them. (At resource start the orphan sweep
 * runs on its own and retention runs on its schedule — see the `onResourceStart` below.)
 *
 * The orphan sweep runs whether or not retention is configured, because it only ever
 * reaches rows whose owner does not exist — data nothing in the phone can read, since
 * every media read is citizenid-scoped. The retention sweep runs only when an owner has
 * asked for it.
 *
 * Each half is caught separately. A `players` table this resource cannot read is a real
 * configuration on some servers and must not stop retention from running, and neither
 * failure may take down resource start.
 */
export const runMediaMaintenance = async (): Promise<{ expired: number; orphaned: number }> => {
  let orphaned = 0;
  try {
    orphaned = await pruneOrphanedMedia();
    if (orphaned > 0) {
      console.log(`[micamedia] removed ${orphaned} row(s) whose character no longer exists.`);
    }
  } catch (error) {
    console.error('[micamedia] orphan sweep failed:', error);
  }

  let expired = 0;
  try {
    expired = await pruneExpiredMedia();
    if (expired > 0) {
      console.log(`[micamedia] removed ${expired} row(s) older than ${retentionDays()} day(s).`);
    }
  } catch (error) {
    console.error('[micamedia] retention sweep failed:', error);
  }

  return { expired, orphaned };
};

/**
 * `micamedia prune` — run the sweeps now, and say exactly what went.
 *
 * **Console-only, the same gate `micaschema apply` carries and for the same reason**:
 * it is the one command in this file that destroys rows. `isAdmin` is checked first so an
 * ordinary player gets the same refusal they would get for the report, rather than being
 * told a privileged subcommand exists.
 *
 * There is no dry run, deliberately — `micamedia` with no argument is the dry run. It
 * reports the size and the top holders, changes nothing, and is what an owner should read
 * before setting a retention window.
 */
export const runMediaPruneCommand = async (source: number): Promise<void> => {
  if (!isAdmin(source)) {
    notifyPlayer(source, {
      type: 'error',
      message: 'You do not have permission to use that.',
      key: 'server.media.noPermission'
    });
    return;
  }

  if (source !== 0) {
    notifyPlayer(source, {
      type: 'error',
      message: 'micamedia prune only runs from the server console.',
      key: 'server.media.consoleOnly'
    });
    return;
  }

  if (isRetentionRunning(mediaRetention.table)) {
    console.log(
      '[micamedia] a retention prune of mica_media is already running; ' +
        'run micamedia prune again when it has finished.'
    );
    return;
  }

  const days = retentionDays();
  if (days <= 0) {
    console.log(
      '[micamedia] mica_media_retention is 0, so nothing is expired by age. ' +
        'The orphan sweep still runs.'
    );
  }

  const { expired, orphaned } = await runMediaMaintenance();
  console.log(
    `[micamedia] prune finished: ${expired} expired row(s), ${orphaned} orphaned row(s) removed.`
  );
};

/**
 * `micamedia` — report-only, same shape as `micaschema` without an `apply` half:
 * nothing here writes anything. Console and any `isAdmin` caller both get the full
 * breakdown in the server console (a top-10 list does not fit a toast), plus a one-line
 * toast for whoever ran it in-game so they know it actually did something.
 *
 * `micamedia prune` is the one subcommand that writes, and it is gated harder — see
 * `runMediaPruneCommand` above.
 */
export const runMediaStatsCommand = async (source: number): Promise<void> => {
  if (!isAdmin(source)) {
    notifyPlayer(source, {
      type: 'error',
      message: 'You do not have permission to use that.',
      key: 'server.media.noPermission'
    });
    return;
  }

  const stats = await mediaStorageStats();

  console.log(
    `[micamedia] ${stats.rowCount} row(s), ${formatBytes(stats.totalBytes)} total ` +
      `(${stats.totalBytes} bytes) in mica_media.`
  );
  if (stats.topHolders.length > 0) {
    console.log(`[micamedia] top ${stats.topHolders.length} by size:`);
    for (const holder of stats.topHolders) {
      console.log(
        `[micamedia]   ${holder.citizenid}: ${holder.rowCount} row(s), ` +
          `${formatBytes(holder.bytes)} (${holder.bytes} bytes)`
      );
    }
  }

  if (source !== 0) {
    notifyPlayer(source, {
      type: 'success',
      message: `mica_media: ${stats.rowCount} rows, ${formatBytes(stats.totalBytes)} — see server console for the breakdown.`,
      key: 'server.media.stats',
      params: { rows: stats.rowCount, size: formatBytes(stats.totalBytes) }
    });
  }
};

RegisterCommand(
  'micamedia',
  (source: number, args: string[]) => {
    if ((args?.[0] ?? '').toLowerCase() === 'prune') {
      void runMediaPruneCommand(source).catch((error) => {
        console.error('[micamedia] prune failed:', error);
      });
      return;
    }

    void runMediaStatsCommand(source).catch((error) => {
      console.error('[micamedia] failed:', error);
    });
  },
  false
);

/**
 * Resource start: say what the limits are, then sweep once.
 *
 * `onResourceStart` rather than module scope, which is where `Notifications.ts` puts its
 * own prune. Two reasons to be later: this reads `players`, a table micaOS does not own,
 * and module evaluation is the earliest possible moment to ask oxmysql for anything; and
 * a sweep that ran on import would run inside every server test suite that loads this
 * file, filling their output with a warning about a `players` table no test has.
 *
 * Failure is logged, never thrown — maintenance must not be able to stop the resource
 * starting. Nothing here blocks anything: no player is connected yet.
 */
on('onResourceStart', (resourceName: string) => {
  if (resourceName !== GetCurrentResourceName()) return;

  logMediaLimits();
  // Both of these read the database, so they wait for the first-start schema check (MICA-306).
  whenSchemaReady(() => {
    // Record the host in use now, so its photos are still counted after it changes. Never
    // throws. Whether a cascade can delete rows before their files are released is said by
    // `Schema.ts`'s start report of keys onto players (MICA-292, MICA-300).
    void rememberImageHost(imageHost());
    // Only the orphan sweep here: the retention half runs on `lib/contentRetention.ts`'s
    // schedule, which starts on this same event, and running it twice at boot buys nothing.
    void pruneOrphanedMedia()
      .then((orphaned) => {
        if (orphaned > 0) {
          console.log(`[micamedia] removed ${orphaned} row(s) whose character no longer exists.`);
        }
      })
      .catch((error) => {
        console.error('[micamedia] start-up maintenance failed:', error);
      });
  });
});
