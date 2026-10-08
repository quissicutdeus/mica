// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PlayerFacingError } from '../errors';
import { MediaItem } from '@mica/shared/types';
import { Database } from '../Database';
import { imageHost, recordedImageHosts } from '../mediaHost';

/**
 * How much a player may store in `mica_media`: the per-row cap on a client write, and the
 * per-player quota measured in the insert itself. Split out of `services/Media.ts`, which
 * is still the service; nothing here registers anything.
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
export const assertStorableData = (value: unknown): void => {
  if (typeof value === 'string' && value.length > MAX_MEDIA_DATA_LENGTH) {
    throw new PlayerFacingError('That photo is too large to store.', {
      key: 'server.media.tooLarge'
    });
  }
};

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
 * What a hosted photo costs when nothing recorded its size. MICA-293.
 *
 * A hosted row keeps only its URL, so `data` is empty and measuring the row alone charged
 * nothing but the thumbnail — the rate limiter was the only cap left on a player's uploads to
 * the owner's host. A row `hostPhoto` wrote from now on carries its real size in `byte_size`;
 * this is the charge for one that does not: every hosted row written before MICA-293, and an
 * `AddMedia` hotlink onto the image host that named no size.
 *
 * 320KiB because it is the size `DEFAULT_QUOTA_MB` was reasoned from: 64MiB was sized as
 * "roughly 150-200 photos", and 64MiB / 320KiB is 204. A library of hosted photos with no
 * recorded size therefore fills at about the count the ceiling was written for — neither
 * a free pass nor a player locked out of a camera they had used a normal amount. It is at
 * the top of MICA-110's measured "few hundred kilobytes" rather than the middle, so the
 * error, where there is one, is on the side of counting a photo as larger than it was.
 */
export const NOMINAL_HOSTED_BYTES = 320 * 1024;

/**
 * The URL prefixes that make a row **hosted**: `https://<host>/` for the image host
 * configured now and every one micaOS recorded using before (MICA-292's ledger), sorted so
 * the statement text is stable. Empty when there has never been a host.
 *
 * A former host counts, the same way `releaseHostedImages` treats it: an owner who moves
 * hosts, or turns uploads off, still has every photo already on the old one in someone's
 * library. A URL on any other host is a hotlink — `AddMedia` and the importer write those —
 * and costs nothing, as it always has: it is not on the owner's storage.
 *
 * Every entry is a `HOSTNAME`-checked name, so a prefix holds no `%`, `_` or backslash that
 * `LIKE` would read as anything but itself — and it is still bound, never interpolated.
 */
export const hostedUrlPrefixes = async (): Promise<string[]> => {
  const hosts = new Set(await recordedImageHosts());
  const current = imageHost();
  if (current) hosts.add(current);
  return [...hosts].sort().map((host) => `https://${host}/`);
};

/**
 * What one row costs, as SQL, for `prefixCount` hosted-URL prefixes bound in order.
 *
 * One expression, used by the quota checks *and* by `mediaStorageStats`, so the number
 * `micamedia` reports and the number a player is measured against cannot drift apart —
 * a quota that disagrees with the report an owner uses to reason about it is worse than
 * no quota.
 *
 * `LENGTH` is bytes, not characters, which is the honest unit here — `data` is base64 and
 * therefore ASCII, so bytes and string length agree, and the same expression stays correct
 * if a future column is not.
 *
 * **A hosted row adds its file's size** (MICA-293): `byte_size` where the upload recorded it,
 * `NOMINAL_HOSTED_BYTES` where nothing did, never below zero. "Hosted" is a byte-exact prefix
 * match — `CAST … AS BINARY` — so it cannot depend on the column's collation and says exactly
 * what `String.startsWith` says in `storedBytesOf`. The stored URL went through
 * `validateHostedUrl`, whose `URL` parse lower-cases the host, so a real hosted row always
 * matches its lower-case prefix.
 *
 * No hosts, no term: an install that never configured one runs the expression it always did.
 */
export const storedBytesSql = (prefixCount: number, alias = ''): string => {
  const column = (name: string): string => (alias ? `${alias}.\`${name}\`` : name);
  const inline = `IFNULL(LENGTH(${column('data')}), 0) + IFNULL(LENGTH(${column('thumbnail')}), 0)`;
  if (prefixCount === 0) return inline;
  const hosted = Array.from(
    { length: prefixCount },
    () => `CAST(${column('url')} AS BINARY) LIKE ?`
  ).join(' OR ');
  return (
    `${inline} + CASE WHEN ${hosted} ` +
    `THEN GREATEST(IFNULL(${column('byte_size')}, ${NOMINAL_HOSTED_BYTES}), 0) ELSE 0 END`
  );
};

/** `prefixes` as the `LIKE` patterns `storedBytesSql` binds, one per prefix. */
export const prefixPatterns = (prefixes: readonly string[]): string[] =>
  prefixes.map((prefix) => `${prefix}%`);

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
export const quotaBytes = (): number => {
  const raw =
    typeof GetConvarInt === 'function'
      ? GetConvarInt('mica_media_quota_mb', DEFAULT_QUOTA_MB)
      : DEFAULT_QUOTA_MB;
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.trunc(raw) * BYTES_PER_MB;
};

/**
 * What a row costs, measured exactly the way `storedBytesSql` measures it, given the same
 * `prefixes` (`hostedUrlPrefixes`). The importer holds a row to the quota with this before it
 * writes one, so the two must agree to the byte.
 */
export const storedBytesOf = (item: Partial<MediaItem>, prefixes: readonly string[]): number => {
  const inline =
    (typeof item.data === 'string' ? item.data.length : 0) +
    (typeof item.thumbnail === 'string' ? item.thumbnail.length : 0);
  const url = item.url;
  if (typeof url !== 'string' || !prefixes.some((prefix) => url.startsWith(prefix))) {
    return inline;
  }
  const size = item.byte_size;
  return inline + Math.max(typeof size === 'number' ? size : NOMINAL_HOSTED_BYTES, 0);
};

/**
 * How much of their ceiling one player is already using, as a subquery rather than as an
 * answer — it is only ever embedded in the statement that acts on it, never awaited on its
 * own, which is the whole of the MICA-131 fix. (The importer is the one exception: it runs
 * offline, from the console, and holds its own running total.)
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
export const usedBytesQuery = (
  citizenid: string,
  prefixes: readonly string[]
): { sql: string; params: unknown[] } => ({
  sql:
    `SELECT COALESCE(SUM(${storedBytesSql(prefixes.length)}), 0) AS used ` +
    `FROM \`mica_media\` WHERE \`citizenid\` = ? AND \`status\` = 'active'`,
  params: [...prefixPatterns(prefixes), citizenid]
});

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
export const insertWithinQuota = async (
  columns: readonly string[],
  values: readonly unknown[],
  citizenid: string,
  prefixes: readonly string[],
  incoming: number,
  limit: number
): Promise<number> => {
  const columnList = columns.map((column) => `\`${column}\``).join(', ');
  const selection = columns.map(() => '?').join(', ');
  const used = usedBytesQuery(citizenid, prefixes);

  return await Database.insert(
    `INSERT INTO \`mica_media\` (${columnList})
     SELECT ${selection}
     FROM (${used.sql}) AS quota
     WHERE quota.used + ? <= ?`,
    [...values, ...used.params, incoming, limit]
  );
};

/**
 * What a player is told when the ceiling refuses their write.
 *
 * It reaches a **player** as a toast, so it names no table and carries no `[Repository]`
 * prefix (§2.9), and it names the remedy — deleting something frees the quota immediately,
 * because the quota counts active rows.
 */
export const QUOTA_FULL_MESSAGE = 'Your photo library is full. Delete something to make room.';
