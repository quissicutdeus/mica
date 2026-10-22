// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { SchemaRepository } from '../defineService';
import { phoneForCitizen } from '../deviceIdentity';
import { MediaItem } from '@mica/shared/types';
import { Database } from '../Database';
import type { Bytes } from 'node:buffer';
import { PlayerFacingError } from '../errors';
import { hostPhoto, refuseUploadWithoutRoom, releaseOnFailure } from './hosting';
import {
  QUOTA_FULL_MESSAGE,
  assertStorableData,
  hostedUrlPrefixes,
  insertWithinQuota,
  quotaBytes,
  storedBytesOf,
  usedBytesQuery
} from './quota';
import {
  UNREADABLE_CONTENT,
  contentContext,
  encryptedColumn,
  sealContent,
  sealRow
} from '../contentCipher';
import { traceOf } from '../sqlErrors';
import { who } from '../who';

/**
 * The columns a proximity drop copies onto each recipient's own row.
 *
 * Everything the sender's row carries except the three the copy must not inherit: `id` and
 * the timestamps are the new row's own, and `citizenid` is supplied per recipient. `status`
 * is deliberately absent too — a copy starts `active` by the table's default rather than
 * inheriting anything, and `drop` has already refused to copy a row that is not.
 *
 * `stored_bytes` travels with the bytes it describes (MICA-358): a copy holds the same `data`,
 * `thumbnail`, `url` and `byte_size`, so it costs its recipient what it cost the sender, and a
 * sender's row with none recorded makes a copy with none, measured from its columns.
 */
const COPIED_COLUMNS = [
  'kind',
  'url',
  'mime_type',
  'width',
  'height',
  'duration_ms',
  'byte_size'
] as const;

/**
 * The columns a copy cannot take from the sender's row as stored (MICA-431): sealed to the
 * sender's phone, they would not open on the recipient's. Each is opened once and sealed again
 * per recipient, and bound into the same `INSERT … SELECT` — so a copy still exists only if its
 * source does. `stored_bytes` is bound beside them, measured from the opened bytes: a sealed
 * value is longer than the bytes it holds, and a copy charged by its ciphertext would cost its
 * recipient a third more than it cost the sender.
 */
const RESEALED_COLUMNS = ['data', 'thumbnail', 'alt_text'] as const;

/** A row about to be written, with the size `stored_bytes` records for it (MICA-358). */
const withStoredBytes = (
  item: Partial<MediaItem>,
  prefixes: readonly string[]
): Partial<MediaItem> =>
  ({ ...item, stored_bytes: storedBytesOf(item, prefixes) }) as Partial<MediaItem>;

/**
 * `mica_media`'s repository: what `repositoryFactory` in `services/Media.ts` builds. Split
 * out of that file, where it was an anonymous class inside the declaration; the reasons for
 * each method are on the method.
 */
export class MediaRepository extends SchemaRepository<MediaItem> {
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
    const device_id = item.device_id ?? (await phoneForCitizen(citizenid));
    // An `AddMedia` photo goes to the host too, when there is one (MICA-243); a
    // location's JSON never does, by kind.
    const stored = await hostPhoto(item);
    return await releaseOnFailure(stored, item, async () =>
      super.create(withStoredBytes({ ...stored, citizenid, device_id }, await hostedUrlPrefixes()))
    );
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
  async create(payload: Partial<MediaItem>): Promise<number> {
    // Bounded before anything else, so an oversized payload is refused rather than
    // posted to a host (MICA-243) and then refused.
    assertStorableData(payload.data);
    await refuseUploadWithoutRoom(payload);
    const item = await hostPhoto(payload);
    return await releaseOnFailure(item, payload, () => this.insertOwned(item));
  }

  /**
   * The insert half of `create`, quota-gated when a ceiling is set. Split out only so
   * `create` can release a hosted file when this refuses or throws (MICA-243).
   */
  async insertOwned(unsized: Partial<MediaItem>): Promise<number> {
    const limit = quotaBytes();
    const citizenid = unsized.citizenid;
    // Measured once, and recorded on the row whether or not a ceiling holds it (MICA-358): a
    // ceiling switched on later sums what was recorded rather than reading every photo.
    const prefixes = await hostedUrlPrefixes();
    const item = withStoredBytes(unsized, prefixes);

    // No ceiling configured, or nobody to measure — the ordinary insert, with the size
    // recorded. `ServiceEndpoint` always supplies a citizenid on this path, so the second half
    // is a guard against a caller that is not the client path at all.
    if (limit <= 0 || typeof citizenid !== 'string' || citizenid.length === 0) {
      return await super.create(item);
    }

    const columns = Object.keys(item);
    // Payload keys, so the allowlist is not optional here (§2.9): MySQL cannot
    // parameterize an identifier, and this method builds its own statement rather than
    // going through `super.create`'s `prepareColumns`.
    for (const column of columns) {
      if (!this.hasColumn(column)) {
        throw new Error(`[Repository] create on '${this.tableName}' rejected '${column}'.`);
      }
    }

    const id = await insertWithinQuota(
      columns,
      columns.map((column) => (item as Record<string, unknown>)[column]),
      citizenid,
      prefixes,
      storedBytesOf(item, prefixes),
      limit,
      (column, value) => this.assertFitsColumn(column, value)
    );

    // Zero rows inserted, so no insert id: the predicate refused. This is the only way
    // the quota says no now — there is no separate check that could disagree with it.
    if (!id) throw new PlayerFacingError(QUOTA_FULL_MESSAGE, { key: 'server.media.quotaFull' });
    return id;
  }

  /**
   * Write one already-authorized row to each nearby player who has room for it.
   * MICA-115, reworked by MICA-131 and MICA-293.
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
   * **Each copy is selected from the sender's row as it stands, not from `source` as
   * `drop` read it** (MICA-293). `drop` reads the row, then looks for who is nearby, then
   * writes; retention, a character purge or the orphan sweep can hard-delete that row in
   * between and — seeing no other row naming its URL yet — ask the image host to delete
   * the file. A copy written from the values read earlier would then land after the check
   * and point every recipient at a deleted file. Selecting from the row in the insert
   * itself means a copy exists only if its source still does, in the same statement:
   *
   * - the copy commits first → the release's reference check, which runs after the
   *   delete, sees the recipient's row and keeps the file;
   * - the delete commits first → the insert selects nothing, that recipient gets no row
   *   and no toast, and the file goes as it should.
   *
   * The seam is here rather than in `releaseHostedImages` because the release already
   * asks the right question — is any row still naming this URL — and cannot be asked it
   * about a row that does not exist yet. It holds on InnoDB's default isolation for the
   * same reason `insertWithinQuota` does: an `INSERT … SELECT` takes a shared lock on the
   * source row it reads, so the delete and the copy serialize. The quota is charged from
   * the same row, so a thumbnail stored on it in the meantime is charged as it is copied.
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
  async copyToPlayers(citizenids: readonly string[], source: MediaItem): Promise<string[]> {
    if (citizenids.length === 0) return [];

    const columns = [
      'citizenid',
      'device_id',
      ...RESEALED_COLUMNS,
      'stored_bytes',
      ...COPIED_COLUMNS
    ];
    // Literals rather than payload keys, and still held to the table's own allowlist:
    // a column renamed out from under this list fails loudly instead of building SQL.
    for (const column of columns) {
      if (!this.hasColumn(column)) {
        throw new Error(`[Repository] copyToPlayers rejected unknown column '${column}'.`);
      }
    }

    const columnList = columns.map((column) => `\`${column}\``).join(', ');
    const bound = ['?', '?', ...RESEALED_COLUMNS.map(() => '?'), '?'].join(', ');
    const copied = COPIED_COLUMNS.map((column) => `src.\`${column}\``).join(', ');
    // The source by id **and** owner and still active, the three things `drop` checked.
    const stillThere = "src.`id` = ? AND src.`citizenid` = ? AND src.`status` = 'active'";
    const limit = quotaBytes();
    const prefixes = await hostedUrlPrefixes();

    const opened = this.openedForCopy(source);
    if (opened === null) return [];
    const bytes = storedBytesOf(opened as Partial<MediaItem>, prefixes);

    const written = await Promise.all(
      citizenids.map(async (citizenid) => {
        try {
          // Each copy lands on the phone its recipient is on (MICA-282) — they are nearby,
          // so almost always the one in their hand.
          const deviceId = await phoneForCitizen(citizenid);
          const sealed = await sealRow(this.tableName, {
            citizenid,
            device_id: deviceId,
            data: opened.data,
            thumbnail: opened.thumbnail,
            alt_text: opened.alt_text
          });
          const values = [
            citizenid,
            deviceId,
            ...RESEALED_COLUMNS.map((column) => sealed[column]),
            bytes
          ];
          let id: number;
          if (limit <= 0) {
            id = await Database.insert(
              `INSERT INTO \`${this.tableName}\` (${columnList})
               SELECT ${bound}, ${copied}
               FROM \`${this.tableName}\` AS src
               WHERE ${stillThere}`,
              [...values, source.id, source.citizenid]
            );
          } else {
            const used = usedBytesQuery(citizenid, prefixes);
            id = await Database.insert(
              `INSERT INTO \`${this.tableName}\` (${columnList})
               SELECT ${bound}, ${copied}
               FROM \`${this.tableName}\` AS src, (${used.sql}) AS quota
               WHERE ${stillThere}
               AND quota.used + ? <= ?`,
              [...values, ...used.params, source.id, source.citizenid, bytes, limit]
            );
          }
          return id ? citizenid : null;
        } catch (error) {
          console.error(`[media] copy to ${who(citizenid)} failed:`, traceOf(error));
          return null;
        }
      })
    );

    return written.filter((citizenid): citizenid is string => citizenid !== null);
  }

  /**
   * The sender's sealed columns, opened, for `copyToPlayers` to seal again per recipient
   * (MICA-431) — from `source`, which `drop` read and opened through `findById`. A photo or a
   * poster frame that did not open there is the padlock, and copied it would be the padlock
   * sealed so it opens, on every recipient's phone, for good: null then, and no copy. Neither
   * can be the padlock honestly, being images. Alt text can, and is copied as the sender sees it.
   */
  private openedForCopy(source: MediaItem): {
    data: string | null;
    thumbnail: string | null;
    alt_text: string | null;
    url: string | undefined;
    byte_size: number | undefined;
  } | null {
    const data = binaryText(source.data);
    const thumbnail = binaryText(source.thumbnail);
    if (data === UNREADABLE_CONTENT || thumbnail === UNREADABLE_CONTENT) {
      console.error(`[media] copy of photo ${String(source.id)} skipped: it does not open.`);
      return null;
    }
    return {
      data,
      thumbnail,
      alt_text: binaryText(source.alt_text),
      url: typeof source.url === 'string' ? source.url : undefined,
      byte_size: typeof source.byte_size === 'number' ? source.byte_size : undefined
    };
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
   * identifier to check against an allowlist — only the bound values.
   *
   * `stored_bytes` grows by the thumbnail in the same statement (MICA-358), so the recorded
   * size cannot fall behind the row. From the bound value rather than the column, which does
   * not depend on the order MariaDB applies the `SET`; the old thumbnail is `NULL` by the
   * predicate, so it had cost nothing. A row with no size recorded keeps none — `NULL + n` —
   * and is still measured from its columns.
   */
  async storeThumbnail(
    id: number,
    citizenid: string,
    deviceId: string,
    thumbnail: string
  ): Promise<boolean> {
    // Sealed to the phone the row is on (MICA-431); the predicate below names that phone, so a
    // row on another one is matched by nothing. Sized from the plaintext, as every write is.
    const entry = encryptedColumn(this.tableName, 'thumbnail');
    const stored = entry
      ? await sealContent(contentContext(entry, { citizenid, device_id: deviceId }), thumbnail)
      : thumbnail;
    return await Database.update(
      `UPDATE \`${this.tableName}\` SET \`thumbnail\` = ?, ` +
        '`stored_bytes` = `stored_bytes` + ? ' +
        'WHERE `id` = ? AND `citizenid` = ? AND `device_id` = ? ' +
        "AND `status` = 'active' AND `thumbnail` IS NULL",
      [stored, storedBytesOf({ thumbnail }, []), id, citizenid, deviceId]
    );
  }

  async findById(
    id: number | string,
    citizenid?: string,
    deviceId?: string
  ): Promise<MediaItem | null> {
    const row = await super.findById(id, citizenid, deviceId);
    return row ? coerceBinaryText(row) : null;
  }
}

/**
 * `data` and `thumbnail` as text. `MediaItem` types them as strings, which is what the phone is
 * sent, but oxmysql hands a binary-collated column back as a `Buffer` — `Bytes`, as
 * `lib/nodeCrypto.d.ts` types it. That is the one other type that reaches here, so it is the
 * one this narrows to.
 */
/** A text column's value as a string, whichever form the driver handed it in. */
const binaryText = (value: unknown): string | null =>
  value === null || value === undefined
    ? null
    : typeof value === 'string'
      ? value
      : (value as Bytes).toString('utf8');

const coerceBinaryText = (item: MediaItem): MediaItem => {
  if (item.data && typeof item.data !== 'string') {
    item.data = (item.data as Bytes).toString('utf8');
  }
  if (item.thumbnail && typeof item.thumbnail !== 'string') {
    item.thumbnail = (item.thumbnail as Bytes).toString('utf8');
  }
  return item;
};
