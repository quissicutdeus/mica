// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PlayerFacingError } from '../errors';
import { MediaItem } from '@mica/shared/types';
import { Database } from '../Database';
import { releaseHostedImages, reportRelease, uploadConfig, uploadImage } from '../mediaHost';
import { QUOTA_FULL_MESSAGE, hostedUrlPrefixes, quotaBytes, usedBytesQuery } from './quota';

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
 *   the quota in `quota.ts` are worth far more than a third off a number nobody was capping.
 *
 * What would change the answer: media that is not a still photo. A voice clip is tens of
 * kilobytes, but video is not, and the day `kind: 'video'` stores real bytes rather than a
 * hotlinked `url`, none of the above holds — a `mediumtext` cannot take a clip, and the
 * `url` column is already the seam that lets a future storage backend arrive without
 * touching the reads. That is a ticket of its own, not a side effect of this one.
 *
 * **MICA-243 made the other answer available without making it the default.** An owner who
 * sets `mica_media_upload_url` has chosen the credential, the dependency and the bill above,
 * so for them a photo's bytes go to that host and the row keeps the URL — through that same
 * `url` seam, so every read already draws it. Unset, everything above still holds and
 * nothing changes. `hostPhoto` below is the one place the choice is made, and
 * `lib/mediaHost.ts` carries the rules: server-side upload, the URL checked before it is
 * stored, and a failed upload falling back to exactly this database path.
 */

/**
 * Kinds whose `data` is an image, and so the only kinds that are ever sent to a host.
 *
 * The same set `MediaThumb` draws a `url` for (`URL_IS_AN_IMAGE`): a hosted row keeps only
 * its URL, so hosting a kind whose URL is not drawn as an image would turn a photo into a
 * placeholder. A location's `data` is JSON and a voice note's is a clip — neither is posted.
 */
const HOSTABLE_KINDS = new Set(['photo', 'gif', 'sticker']);

/**
 * `item` with its bytes moved to the image host, or `item` unchanged. MICA-243.
 *
 * Unchanged when no host is configured, when the row is not an image kind, and — the rule
 * that matters — **when the upload fails for any reason**: `uploadImage` logs and answers
 * `null`, and the caller writes the bytes to the database as it always did. A host outage
 * is a slower, fatter row, never a lost photo.
 *
 * On success `data` is left out rather than nulled, so the insert names no column it does
 * not write, `mime_type` records what the host was sent, and `byte_size` how big it was —
 * the size the quota charges for a row whose bytes are no longer in it (MICA-293). `url` is `clientWritable:
 * false` and stays so: the value here came from the host through `validateHostedUrl`, never
 * from a payload, and this runs after `ServiceEndpoint` has already reduced the payload.
 */
export const hostPhoto = async (item: Partial<MediaItem>): Promise<Partial<MediaItem>> => {
  if (!HOSTABLE_KINDS.has(item.kind ?? 'photo') || typeof item.data !== 'string') return item;
  const hosted = await uploadImage(item.data);
  if (!hosted) return item;
  const { data: _bytes, ...rest } = item;
  return { ...rest, url: hosted.url, mime_type: hosted.mimeType, byte_size: hosted.bytes };
};

/**
 * Run `insert`, and if it refuses or throws after `hostPhoto` moved the bytes to the host,
 * ask the host to delete the file before rethrowing. MICA-243.
 *
 * The upload has to happen before the insert — the quota is a predicate *in* the insert
 * (MICA-131), so there is no earlier moment at which "will this row be written" is known.
 * Without this, a player at their ceiling, or any failed insert, leaves a file on the host
 * that no row names and no prune will ever find. `releaseHostedImages` never throws and
 * checks no row names the URL first, so the caller's own error is the one that surfaces.
 */
export const releaseOnFailure = async (
  stored: Partial<MediaItem>,
  original: Partial<MediaItem>,
  insert: () => Promise<number>
): Promise<number> => {
  try {
    return await insert();
  } catch (error) {
    if (stored !== original && typeof stored.url === 'string') {
      reportRelease('micamedia', await releaseHostedImages([stored.url]));
    }
    throw error;
  }
};

/**
 * The least a capture can cost once hosted: its decoded file size, which is exactly the
 * `byte_size` `hostPhoto` records. `null` for anything `uploadImage` would not post.
 */
const hostedBytesAtLeast = (data: string): number | null => {
  const match = /^data:image\/(?:jpeg|png|webp|gif);base64,([A-Za-z0-9+/]+)(={0,2})$/.exec(data);
  if (!match) return null;
  return ((match[1].length + match[2].length) / 4) * 3 - match[2].length;
};

/**
 * Refuse a capture before it is posted to the image host when the player's library cannot
 * take it even at its smallest. MICA-293.
 *
 * Without this, a player already at their ceiling uploads every capture to the owner's host,
 * is refused by `insertWithinQuota`, and `releaseOnFailure` deletes the file again: two
 * requests to somebody else's host per retry, for a photo that was never going to be kept.
 *
 * **A pre-check, never the authority.** It reads the library in a statement of its own, so
 * it has exactly the MICA-131 gap `insertWithinQuota` exists to close — two captures in
 * flight can both pass it. That is fine here because passing it decides nothing: the insert
 * still carries the predicate, and this only ever says no. It measures the smallest the row
 * can be (the decoded file; a failed upload stores the larger base64 instead), so it refuses
 * only what the insert would certainly refuse too.
 *
 * Only on the path that would upload — a host configured, an image kind, a data URI — so an
 * install without a host pays no extra statement per capture.
 */
export const refuseUploadWithoutRoom = async (item: Partial<MediaItem>): Promise<void> => {
  const limit = quotaBytes();
  const citizenid = item.citizenid;
  if (limit <= 0 || typeof citizenid !== 'string' || citizenid.length === 0) return;
  if (!HOSTABLE_KINDS.has(item.kind ?? 'photo') || typeof item.data !== 'string') return;
  if (!uploadConfig()) return;
  const smallest = hostedBytesAtLeast(item.data);
  if (smallest === null) return;

  const used = usedBytesQuery(citizenid, await hostedUrlPrefixes());
  const current = Number((await Database.scalar<number | null>(used.sql, used.params)) ?? 0);
  if (current + smallest > limit) {
    throw new PlayerFacingError(QUOTA_FULL_MESSAGE, { key: 'server.media.quotaFull' });
  }
};
