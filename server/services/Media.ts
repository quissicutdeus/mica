// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PlayerFacingError } from '../lib/errors';
import { defineService, SchemaRepository } from '../lib/defineService';
import { phoneForCitizen } from '../lib/phoneIdentity';
import { MediaItem } from '@mica/shared/types';
import { findNearbyVisiblePlayers } from '../lib/proximity';
import { appEventChannel } from '../lib/appEvents';
import { mediaContract } from '@mica/shared/contracts/media';
import { playerCoords } from '../lib/playerCoords';
import { Database } from '../lib/Database';
import { sweepOrphanedRows } from '../lib/orphanSweep';
import { isAdmin } from './Admin';
import { notifyPlayer } from '../lib/shell';
import { restoreWindowDays } from '../lib/retention';

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
 * The largest `data` a client may write through the generic `create`, as a base64 payload.
 *
 * Sized from what the capture path can actually produce, never from what the column
 * tolerates (MICA-116). `mediumtext` holds 16MB and `assertWritableValue` has nothing
 * narrower to check it against, so before this the honest answer to "how big may a photo
 * be" was "sixteen megabytes, sixty times a minute, per player, into a table with no
 * retention" — a gigabyte a minute from one modified client.
 *
 * The arithmetic, from the camera's own constants:
 *
 * - `CAPTURE_MAX_DIMENSION` is 1080 and caps the **longer** edge, so the largest frame the
 *   crop math can emit is a square 1080x1080 — 1.17 megapixels. Today's viewfinder is
 *   portrait inside a 400x850 screen, so a real capture is nearer half that; the square is
 *   the ceiling a future landscape crop could reach under the same rule.
 * - One lossy encode at `mica_camera_quality`, which a server owner may set as high as
 *   100. Dense game content at that setting runs around two bytes a pixel worst case, so
 *   roughly 2.3MB of encoded bytes.
 * - Base64 and the data-URI prefix add a third: about 3.1MB on the wire.
 *
 * Four mebibytes is that worst case with room above it, so no legitimate photo is ever
 * refused. Against a real capture — a few hundred kilobytes, the size MICA-110 measured
 * — it is roughly a tenfold margin; against the column it is a quarter. It is a backstop
 * for a payload nothing in this codebase could have produced, not a compression target:
 * `mica_camera_quality` is the knob for how big photos actually get.
 *
 * Checked at the boundary rather than in the schema for the same reason
 * `MAX_THUMBNAIL_LENGTH` is: a text column's only bound is its type. Making `maxLength` a
 * first-class schema field, so the next `mediumtext` column inherits a sane bound without
 * anyone remembering to write one, is the better fix and belongs to `defineService` rather
 * than to this file.
 */
const MAX_MEDIA_DATA_LENGTH = 4 * 1024 * 1024;

/**
 * Refuse a payload far larger than the camera could have produced.
 *
 * The message reaches a **player** as a toast, so it carries no `[Repository]` prefix and
 * no table name (§2.9) — the same rule `assertWritableValue`'s own messages obey.
 */
const assertStorableData = (value: unknown): void => {
  if (typeof value === 'string' && value.length > MAX_MEDIA_DATA_LENGTH) {
    throw new PlayerFacingError('That photo is too large to store.', {
      key: 'server.media.tooLarge'
    });
  }
};

/**
 * MICA-71, and the decision the rest of this section rests on: **the bytes stay in
 * MySQL, base64, in `data`.**
 *
 * Written down because "should this be on disk instead" is the question anyone reading a
 * `mediumtext` full of base64 asks first, and answering it silently by moving the storage
 * is a far larger change than the ticket that prompted it. The reasons it stays:
 *
 * - **A FiveM resource has no static file host it can write to.** Files are served out of
 *   the resource directory, which is deployed content — writing player data into it means
 *   a resource that mutates its own install, and anything a `refresh`/`ensure` cycle or a
 *   redeploy sweeps away takes the gallery with it. An external object store (S3, a CDN)
 *   is a credential, a network dependency and a bill that a drop-in phone resource cannot
 *   assume every server owner has.
 * - **Backups already cover it.** A server owner backs up one MySQL database and has the
 *   whole phone. Splitting the payload out means a gallery that can disagree with its own
 *   rows — a restore that has the row and not the file, or the file and not the row.
 * - **The delivery path is a data URI either way.** CEF renders `data:image/webp;base64,…`
 *   directly, so nothing downstream is waiting on a URL. Moving to files buys a second
 *   fetch per tile and an origin to configure, not less work.
 * - **The cost was never the encoding, it was the absence of bounds.** Base64 is a 33%
 *   tax; unbounded rows, no per-player ceiling and no retention were the actual problem,
 *   and those are fixable in place. `mica_camera_quality`, `MAX_MEDIA_DATA_LENGTH` and
 *   the quota below are worth far more than a third off a number nobody was capping.
 *
 * What would change the answer: media that is not a still photo. A voice clip is tens of
 * kilobytes, but video is not, and the day `kind: 'video'` stores real bytes rather than a
 * hotlinked `url`, none of the above holds — a `mediumtext` cannot take a clip, and the
 * `url` column is already the seam that lets a future storage backend arrive without
 * touching the reads. That is a ticket of its own, not a side effect of this one.
 */

/**
 * The default ceiling on one player's live media, in mebibytes.
 *
 * Sized from what a real gallery weighs rather than from what the table could survive.
 * MICA-110 measured a capture at a few hundred kilobytes, so 64MiB is roughly 150-200
 * photos — a library a player has to work at to fill, and one they would have to scroll a
 * long way to see the end of. A hundred players at the ceiling is 6.4GB, which is a number
 * a server owner can hold in their head and decide about.
 *
 * It composes with `MAX_MEDIA_DATA_LENGTH` rather than competing with it: the per-row cap
 * bounds one write, this bounds the sum of them.
 *
 * **This used to claim a worst case of the quota plus one capped row — 68MiB — and call
 * that overshoot deliberate. The claim was wrong (MICA-131), and it is worth saying why
 * rather than quietly deleting it.** It assumed one write in flight per player. Nothing
 * establishes that: `rateLimit.allow` increments a counter and returns, nothing decrements
 * it on completion, and `ServiceEndpoint` awaits the handler with no queue or per-player
 * serialization behind it. "60 per minute" therefore permits 60 *simultaneously*, and a
 * check that read a `SUM` and then issued an unconditional `INSERT` was 60 × 4MiB past a
 * 64MiB ceiling, not one row past it.
 *
 * **And 60 was itself the wrong number to reason with.** `rateLimit` keys on
 * `source:service:action`, so the ceiling is per *action*, not per player: one client gets
 * 60 concurrent `create` **and** 60 concurrent `drop`, and N clients get N times that. Any
 * bound derived from the limiter is therefore a bound on one action from one connection and
 * on nothing else — which is worth writing down, because it is the assumption that made the
 * original comment wrong and it would make the next one wrong the same way.
 *
 * The bound is real now because the predicate is *in* the statement rather than in front of
 * it — see `insertWithinQuota` — and it holds however many writes are in flight and whoever
 * issued them. What survives of the original reasoning is only the direction of the
 * rounding: a write is measured against the library as it stands, so a player sitting just
 * under the line can still add a row that fits.
 */
const DEFAULT_QUOTA_MB = 64;

const BYTES_PER_MB = 1024 * 1024;

/**
 * What one row costs, as SQL.
 *
 * One expression, used by the quota checks *and* by `mediaStorageStats`, so the number
 * `micamedia` reports and the number a player is measured against cannot drift apart —
 * a quota that disagrees with the report an owner uses to reason about it is worse than
 * no quota. `byte_size` (the column) is still not the answer: nothing writes it.
 *
 * `LENGTH` is bytes, not characters, which is the honest unit here — `data` is base64 and
 * therefore ASCII, so bytes and string length agree, and the same expression stays correct
 * if a future column is not.
 */
const STORED_BYTES_SQL = 'IFNULL(LENGTH(data), 0) + IFNULL(LENGTH(thumbnail), 0)';

/**
 * The per-player ceiling in bytes, or `0` for no ceiling.
 *
 * **A bad value disables the quota rather than locking players out**, and that direction is
 * chosen, not inherited. `GetConvarInt` answers `0` for anything it cannot parse, so a typo
 * lands here as "off" — which leaves the phone behaving exactly as it did before this
 * ticket. The opposite failure would refuse every photo on the server because of a stray
 * character in `server.cfg`. It is loud rather than silent: `logMediaLimits` prints the
 * resolved value at resource start, so "off" is something an owner reads rather than
 * discovers.
 */
const quotaBytes = (): number => {
  const raw =
    typeof GetConvarInt === 'function'
      ? GetConvarInt('mica_media_quota_mb', DEFAULT_QUOTA_MB)
      : DEFAULT_QUOTA_MB;
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.trunc(raw) * BYTES_PER_MB;
};

/** What a row about to be written will cost, measured the same way SQL measures it. */
const storedBytesOf = (item: Partial<MediaItem>): number =>
  (typeof item.data === 'string' ? item.data.length : 0) +
  (typeof item.thumbnail === 'string' ? item.thumbnail.length : 0);

/**
 * How much of their ceiling one player is already using, as a subquery rather than as an
 * answer — it is only ever embedded in the statement that acts on it, never awaited on its
 * own, which is the whole of the MICA-131 fix.
 *
 * `status = 'active'` on purpose, and it is the one judgement call in the quota. Counting
 * every status would make the table's total size the bound — tidier arithmetic — but it
 * would also mean a player at the ceiling could delete every photo they own and still be
 * refused, with nothing they could do about it. So the quota measures the library the
 * player can actually see and manage.
 *
 * The consequence is stated rather than hidden: a soft-deleted row keeps its bytes and no
 * longer counts against anyone, so capture-then-delete can still grow the table past the
 * sum of every player's quota. `mica_media_retention` is the owner's tool for that and
 * `micamedia` is how they see whether they need it. Closing it properly means either
 * hard-deleting on the player's own delete — which throws away the evidence a report of
 * that photo is built on (`reportable.previewColumn`) — or a second grace-window knob, and
 * both are bigger decisions than this ticket.
 */
const USED_BYTES_SQL =
  `SELECT COALESCE(SUM(${STORED_BYTES_SQL}), 0) AS used ` +
  `FROM \`mica_media\` WHERE \`citizenid\` = ? AND \`status\` = 'active'`;

/**
 * The quota as a **predicate on the insert**, not a question asked before it. MICA-131.
 *
 * `INSERT … SELECT … FROM (aggregate) WHERE used + ? <= ?`. The row is written only if the
 * ceiling still has room *at the moment MySQL evaluates the statement*, so there is no gap
 * between deciding and writing — the same reasoning `Repository.applyUpdate` gives for
 * folding the edit window into the UPDATE's WHERE, and the same shape `Hodlr` sell uses
 * with its `quantity >= ?` guard.
 *
 * The aggregate is wrapped in a derived table rather than left as a scalar subquery in the
 * WHERE. Two reasons, and only the second is about taste: MySQL is prickly about naming the
 * insert target inside the statement selecting into it, and a derived table is the standard
 * way round that; and `used` reads as a value the WHERE compares, which is what it is.
 *
 * **What this does and does not guarantee, stated plainly, because the difference matters.**
 * A `SUM` over other rows is not a row lock. Under InnoDB's default isolation an
 * `INSERT … SELECT` takes shared locks on the rows it scans, so two concurrent captures by
 * one player normally serialize or deadlock — either way one of them loses, which is the
 * point. But a driver or isolation level that made the read non-locking would degrade this
 * to *exactly the behaviour it replaces*, never to something worse: the arithmetic is still
 * evaluated against committed rows one statement later than the old pre-check managed. This
 * is the weakest of the six predicates in MICA-131/132 for that reason, and it is the only
 * one whose strength depends on the engine rather than on a unique key or a single-row
 * `WHERE`. A maintained counter column would be strictly stronger; it would also be a new
 * column to keep in step with soft deletes, the retention prune, the orphan sweep and
 * `AddMedia`, and a counter that drifts high locks a player out of their own camera with no
 * way to see why. Refusing to add a second source of truth for a number the rows already
 * hold is the trade being made here.
 */
const insertWithinQuota = async (
  columns: readonly string[],
  values: readonly unknown[],
  citizenid: string,
  incoming: number,
  limit: number
): Promise<number> => {
  const columnList = columns.map((column) => `\`${column}\``).join(', ');
  const selection = columns.map(() => '?').join(', ');

  return await Database.insert(
    `INSERT INTO \`mica_media\` (${columnList})
     SELECT ${selection}
     FROM (${USED_BYTES_SQL}) AS quota
     WHERE quota.used + ? <= ?`,
    [...values, citizenid, incoming, limit]
  );
};

/**
 * What a player is told when the ceiling refuses their write.
 *
 * It reaches a **player** as a toast, so it names no table and carries no `[Repository]`
 * prefix (§2.9), and it names the remedy — deleting something frees the quota immediately,
 * because the quota counts active rows.
 */
const QUOTA_FULL_MESSAGE = 'Your photo library is full. Delete something to make room.';

/**
 * The columns a proximity drop copies onto each recipient's own row.
 *
 * Everything the sender's row carries except the three the copy must not inherit: `id` and
 * the timestamps are the new row's own, and `citizenid` is supplied per recipient. `status`
 * is deliberately absent too — a copy starts `active` by the table's default rather than
 * inheriting anything, and `drop` has already refused to copy a row that is not.
 */
const COPIED_COLUMNS = [
  'kind',
  'data',
  'url',
  'thumbnail',
  'mime_type',
  'width',
  'height',
  'duration_ms',
  'byte_size',
  'alt_text'
] as const;

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
       *
       * `super.create`, deliberately: the `create` override below bounds `data` to what
       * this phone's own camera can emit, and that number has no authority over a resource
       * handing the gallery a voice clip or a video poster. Nothing reaching this method is
       * a client payload — a server owner installed whatever is calling it — so it keeps
       * the column's bound rather than the camera's.
       */
      async addForPlayer(citizenid: string, item: Partial<MediaItem>): Promise<number> {
        // Onto the phone the citizen is on (MICA-282), unless the caller already knows which —
        // `shareLocation` does, from the request; `AddMedia` does not, and a row on no phone
        // is one no phone ever shows.
        const phone_id = item.phone_id ?? (await phoneForCitizen(citizenid));
        return await super.create({ ...item, citizenid, phone_id } as Partial<MediaItem>);
      }

      /**
       * The generic `create`, with the one bound `mediumtext` does not give it. MICA-116.
       *
       * Every other caller of this class reaches the table through a **named** method
       * (`addForPlayer`, `copyToPlayers`, `storeThumbnail`), so this override is exactly
       * the client-writable path and nothing else. `ServiceEndpoint` has already reduced
       * the payload to `clientWritable` columns by the time it arrives; what is left to
       * check is the one thing the schema cannot say.
       *
       * The quota (MICA-71) is checked here for the same reason and in the same place:
       * `ServiceEndpoint` supplies `citizenid` on the way in, so this is the first point
       * that knows both who is writing and how much. `addForPlayer` deliberately does not
       * check it — a resource a server owner installed is not a client payload, and the
       * argument `super.create` already carries for the per-row cap applies unchanged.
       */
      async create(item: Partial<MediaItem>): Promise<number> {
        assertStorableData(item.data);

        const limit = quotaBytes();
        const citizenid = item.citizenid;

        // No ceiling configured, or nobody to measure — the ordinary insert, byte for byte
        // what it always was. `ServiceEndpoint` always supplies a citizenid on this path, so
        // the second half is a guard against a caller that is not the client path at all.
        if (limit <= 0 || typeof citizenid !== 'string' || citizenid.length === 0) {
          return await super.create(item);
        }

        const columns = Object.keys(item);
        // Payload keys, so the allowlist is not optional here (§2.9): MySQL cannot
        // parameterize an identifier, and this method builds its own statement rather than
        // going through `super.create`'s `prepareColumns`.
        for (const column of columns) {
          if (!this.tableColumns.includes(column)) {
            throw new Error(`[Repository] create on '${this.tableName}' rejected '${column}'.`);
          }
        }

        const id = await insertWithinQuota(
          columns,
          columns.map((column) => (item as Record<string, unknown>)[column]),
          citizenid,
          storedBytesOf(item),
          limit
        );

        // Zero rows inserted, so no insert id: the predicate refused. This is the only way
        // the quota says no now — there is no separate check that could disagree with it.
        if (!id) throw new PlayerFacingError(QUOTA_FULL_MESSAGE, { key: 'server.media.quotaFull' });
        return id;
      }

      /**
       * Write one already-authorized row to each nearby player who has room for it.
       * MICA-115, reworked by MICA-131.
       *
       * A **named** method rather than a loop of `create` calls in the service, for the
       * reason §2.9 gives named methods generally: the row being copied has already passed
       * its ownership and status checks in `drop`, there is no payload here to reduce, every
       * column named is a literal in this file and every value stays bound.
       *
       * **It answers with the recipients it actually wrote, not a count**, and that is the
       * change. A drop is the one path where one tap multiplies stored bytes across other
       * people's libraries, so the recipient a copy is refused for is a **bystander who
       * pressed nothing** — they must not be pushed over their own ceiling by somebody
       * else's gesture, and they must not be told they received a photo that no row exists
       * for. Both need the same thing: the set of writes that really happened.
       *
       * This used to be one multi-row `INSERT … VALUES` behind a `SUM` measured for the
       * whole group beforehand, which is the MICA-131 shape exactly — the measurement and
       * the write were separate statements, so two senders dropping onto one bystander both
       * measured them as under the ceiling and both wrote. There is no way to give a
       * multi-row `VALUES` a per-row predicate, so it becomes one conditional insert per
       * recipient, and the count comes back from what the database did rather than from the
       * length of the list handed in.
       *
       * **Concurrent, not sequential**, which is what makes that affordable: the objection
       * the batch was written against was thirty *sequential* awaits on a busy corner, and
       * these are one round trip in wall clock. The fan-out is bounded well below that
       * anyway — `proximity.MAX_NEARBY` is 16 whatever a server owner sets, and the default
       * is 5 — so this is at most sixteen pooled statements, never an unbounded fan-out.
       *
       * That cap bounds **recipients per drop and nothing else**, which is precisely why the
       * predicate has to be per recipient rather than per call: re-dropping the same photo
       * is a fresh call each time, so the bytes one bystander can be sent are bounded only
       * by their own ceiling. The cap sizes the statement; the ceiling is what refuses.
       *
       * A recipient whose insert *throws* is logged and left out of the answer rather than
       * failing the whole drop: the copies that did land are already committed, and losing
       * every other recipient's notification because one statement failed is the worse
       * outcome. Same reasoning `drop` gives for logging a refused push.
       */
      async copyToPlayers(citizenids: readonly string[], item: MediaItem): Promise<string[]> {
        if (citizenids.length === 0) return [];

        const columns = ['citizenid', 'phone_id', ...COPIED_COLUMNS];
        // Literals rather than payload keys, and still held to the table's own allowlist:
        // a column renamed out from under this list fails loudly instead of building SQL.
        for (const column of columns) {
          if (!this.tableColumns.includes(column)) {
            throw new Error(`[Repository] copyToPlayers rejected unknown column '${column}'.`);
          }
        }

        const columnList = columns.map((column) => `\`${column}\``).join(', ');
        const placeholders = columns.map(() => '?').join(', ');
        const copied = COPIED_COLUMNS.map((column) => item[column] ?? null);
        const limit = quotaBytes();
        const incoming = storedBytesOf(item);

        const written = await Promise.all(
          citizenids.map(async (citizenid) => {
            try {
              // Each copy lands on the phone its recipient is on (MICA-282) — they are nearby,
              // so almost always the one in their hand.
              const phoneId = await phoneForCitizen(citizenid);
              const id =
                limit <= 0
                  ? await Database.insert(
                      `INSERT INTO \`${this.tableName}\` (${columnList}) VALUES (${placeholders})`,
                      [citizenid, phoneId, ...copied]
                    )
                  : await insertWithinQuota(
                      columns,
                      [citizenid, phoneId, ...copied],
                      citizenid,
                      incoming,
                      limit
                    );
              return id ? citizenid : null;
            } catch (error) {
              console.error(`[media] copy to ${citizenid} failed:`, error);
              return null;
            }
          })
        );

        return written.filter((citizenid): citizenid is string => citizenid !== null);
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
      async storeThumbnail(
        id: number,
        citizenid: string,
        phoneId: string,
        thumbnail: string
      ): Promise<boolean> {
        return await Database.update(
          `UPDATE \`${this.tableName}\` SET \`thumbnail\` = ? ` +
            'WHERE `id` = ? AND `citizenid` = ? AND `phone_id` = ? ' +
            "AND `status` = 'active' AND `thumbnail` IS NULL",
          [thumbnail, id, citizenid, phoneId]
        );
      }

      async findById(
        id: number | string,
        citizenid?: string,
        phoneId?: string
      ): Promise<MediaItem | null> {
        const row = await super.findById(id, citizenid, phoneId);
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
   */
  const privileged = repo as unknown as {
    copyToPlayers(citizenids: readonly string[], item: MediaItem): Promise<string[]>;
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
            SUM(${STORED_BYTES_SQL}) AS totalBytes
     FROM mica_media`
  );

  const holders = await Database.query<MediaHolderRow[]>(
    `SELECT citizenid,
            COUNT(*) AS rowCount,
            SUM(${STORED_BYTES_SQL}) AS bytes
     FROM mica_media
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
 * How many rows a `DELETE` actually removed.
 *
 * `Database.query` hands back whatever the driver returned, and oxmysql's shape for a
 * write is an object carrying `affectedRows`. Anything else counts as zero rather than
 * `NaN` — a maintenance routine that reports nonsense is worse than one that reports
 * nothing, because the number is the only evidence an owner has that it ran.
 */
const affectedRows = (result: unknown): number => {
  if (result && typeof result === 'object' && 'affectedRows' in result) {
    const value = Number((result as { affectedRows?: unknown }).affectedRows);
    return Number.isFinite(value) ? value : 0;
  }
  return 0;
};

/**
 * How many days of media are kept, or `0` for forever.
 *
 * **Off by default, and that is the conservative answer rather than a placeholder.** This
 * is the only thing in this file that destroys a photo a player still expects to have, so
 * an update that sets nothing must not start deleting anybody's gallery. An owner who
 * wants the reclaim opts into it, having read what it does.
 *
 * The quota above is what bounds ordinary growth without deleting anything; retention is
 * for the owner who has looked at `micamedia` and decided the table is still too big.
 */
const retentionDays = (): number => {
  const raw = typeof GetConvarInt === 'function' ? GetConvarInt('mica_media_retention', 0) : 0;
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 0;
};

/**
 * Delete every media row older than the retention window. **A hard delete.**
 *
 * Worth being exact about, because the word means two different things in this schema
 * (MICA-75): a player deleting a photo writes `status = 'deleted'` and the row keeps
 * every byte it had, which is why a soft delete reclaims nothing and why this exists. This
 * removes the row.
 *
 * `created_at` rather than `updated_at`, and every status rather than a subset, so the
 * sentence an owner is agreeing to has no exceptions in it: *media older than N days is
 * removed*. A window that covered only some rows would be a window nobody could reason
 * about, and the rule for a prune is that it never reaches a row the stated window does
 * not clearly cover.
 *
 * Nothing is written unless the convar is set, so the default path here is a no-op that
 * touches the database not at all.
 */
export const pruneExpiredMedia = async (): Promise<number> => {
  const days = retentionDays();
  if (days <= 0) return 0;

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  return affectedRows(
    await Database.query('DELETE FROM mica_media WHERE created_at < ?', [cutoff])
  );
};

/**
 * Delete media whose owner no longer exists. **A hard delete, and the character-deletion
 * cleanup.**
 *
 * The first line of defence is not this: on qb every micaOS table is generated with
 * `FOREIGN KEY (citizenid) REFERENCES players (citizenid) ON DELETE CASCADE`
 * (`lib/schemaSql.ts`), so on a table created from `mica.sql` a deleted character takes
 * its photos with it inside the same statement, with no resource involvement at all. That
 * is the mechanism, and it is already correct.
 *
 * This is the backstop for the four ways that guarantee does not hold, none of which the
 * database will tell you about:
 *
 * - **ESX**, which has no `players` table to point a constraint at, so `mica.esx.sql`
 *   carries no cascade to drop the rows (MICA-150). That is the case this sweep could
 *   not cover until MICA-152 taught it to ask `users(identifier)` the same question, and
 *   it is why this function no longer names a table itself.
 * - A table created before the constraint existed. `SchemaMigrator` adds columns and keys
 *   and deliberately never adds a foreign key, so an older install keeps the shape it was
 *   created with.
 * - A framework that retires a character without removing the `players` row.
 * - A `players` table on an engine that accepts a foreign key and does not enforce one.
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
 * Remove one character's media outright. **A hard delete.**
 *
 * The immediate half of the cleanup above: a deletion flow that calls this reclaims the
 * bytes at once instead of waiting for the next restart's sweep, and it works on an
 * install whose `players` row survives the character.
 */
export const purgeMediaForCitizen = async (citizenid: string): Promise<number> => {
  const owner = typeof citizenid === 'string' ? citizenid.trim() : '';
  if (owner.length === 0) return 0;

  return affectedRows(await Database.query('DELETE FROM mica_media WHERE citizenid = ?', [owner]));
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
 * A name a server owner wires up on purpose either fires or visibly does not, and the FK
 * cascade plus `pruneOrphanedMedia` cover the owner who wires up nothing.
 */
on('mica:server:media:characterDeleted', (rawCitizenid: unknown) => {
  const citizenid = typeof rawCitizenid === 'string' ? rawCitizenid.trim() : '';
  if (citizenid.length === 0) return;

  void purgeMediaForCitizen(citizenid)
    .then((removed) => {
      if (removed > 0) {
        console.log(`[micamedia] purged ${removed} row(s) for deleted character ${citizenid}.`);
      }
    })
    .catch((error) => {
      console.error('[micamedia] purge for a deleted character failed:', error);
    });
});

/**
 * Say what the limits actually resolved to, once, at resource start.
 *
 * A quota that a typo turned off is the failure this line exists to make loud. Both knobs
 * fall back rather than throw — the right behaviour for something that would otherwise
 * refuse every photo on the server — and a fallback nobody is told about is a setting an
 * owner believes is in force.
 *
 * (Both convar names are written as literals at their `GetConvarInt` call site rather than
 * hoisted into a `const`. That is what `convars.test.ts` reads to check the name is
 * documented in the README, and a literal is the form it resolves without guessing.)
 */
const logMediaLimits = (): void => {
  const limit = quotaBytes();
  const days = retentionDays();
  console.log(
    `[micamedia] per-player quota ${limit > 0 ? formatBytes(limit) : 'off'}, ` +
      `retention ${days > 0 ? `${days} day(s)` : 'off'}.`
  );
};

/**
 * The prune, as it runs on its own: at resource start, and again on `micamedia prune`.
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

  const days = retentionDays();
  if (days <= 0) {
    console.log(
      '[micamedia] mica_media_retention is not set, so nothing is expired by age. ' +
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
  void runMediaMaintenance().catch((error) => {
    console.error('[micamedia] start-up maintenance failed:', error);
  });
});
