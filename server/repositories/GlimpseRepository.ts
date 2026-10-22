// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { SchemaRepository, type ResolvedService } from '../lib/defineService';
import { Database } from '../lib/Database';
import { joinedMedia } from '../lib/media/joined';
import { openRow } from '../lib/contentCipher';
import type { GlimpsePost, MediaPreview } from '@mica/shared/types';

/**
 * Hydration for Glimpse's posts (MICA-253): each row's author and its carousel.
 *
 * The same reasoning as `BlabberRepository`, which this follows: every read here returns rows
 * the reader does not own, so the handle, display name and avatar are joined on, batched per
 * page, and the joins name their columns. **Neither join selects a `citizenid`** — not the
 * author's from `mica_accounts`, and not the uploader's from `mica_media` or the attachment
 * row. With several accounts per player, either would correlate an alt back to its owner.
 */

/** What a reader is allowed to know about an author. No `citizenid`, ever. */
interface AuthorRow {
  id: number;
  handle: string;
  display_name: string | null;
  avatar: string | null;
}

/** A row that carries an author to hydrate. */
interface Authored {
  account_id: number;
  handle?: string;
  display_name?: string | null;
  avatar?: string | null;
}

const distinctIds = (values: (number | null | undefined)[]): number[] => [
  ...new Set(
    values
      .map((value) => Number(value))
      .filter((value): value is number => Number.isInteger(value) && value > 0)
  )
];

/**
 * The display fields for a page's authors, onto the rows in place.
 *
 * Shared with `GlimpseCommentRepository`, so a comment and a post cannot disagree about what an
 * author looks like. Not filtered by account status, for `BlabberRepository.selectAuthors`'
 * reason: a post from a deleted account should not render with a blank author.
 */
export const attachAuthors = async <T extends Authored>(rows: T[]): Promise<T[]> => {
  const ids = distinctIds(rows.map((row) => row.account_id));
  if (ids.length === 0) return rows;

  const authors = await Database.query<AuthorRow[]>(
    `SELECT \`id\`, \`handle\`, \`display_name\`, \`avatar\` FROM \`mica_accounts\`
     WHERE \`id\` IN (${ids.map(() => '?').join(', ')})`,
    ids
  );
  const byId = new Map((authors ?? []).map((row) => [Number(row.id), row]));

  for (const row of rows) {
    const author = byId.get(Number(row.account_id));
    if (!author) continue;
    row.handle = author.handle;
    row.display_name = author.display_name ?? null;
    row.avatar = author.avatar ?? null;
  }
  return rows;
};

export class GlimpseRepository extends SchemaRepository<GlimpsePost> {
  /** The declaration's public projection, for the hand-built reads below. */
  private readonly publicColumns: readonly string[];

  constructor(resolved: ResolvedService) {
    super(resolved);
    this.publicColumns = resolved.publicColumns;
  }

  /**
   * Insert the post, then its photos in posting order. The handler has already run every id
   * through `resolveOwnedAttachments`, so what arrives here is the caller's own live photos.
   *
   * oxmysql's transaction answers a boolean and no insert id, and the attachments need the
   * post's id, so this is not one transaction. It is the next best thing: the photos go in as
   * **one** multi-row `INSERT`, which InnoDB applies whole or not at all, and if it fails — a
   * photo purged between the ownership check and here fails its foreign key — the post is
   * soft-deleted under its own `citizenid` before the error is rethrown. A post therefore never
   * stays live without the photos it was posted with, and a retry after a failure leaves one
   * live post, not two. A soft delete rather than a `DELETE`, because a hard delete would
   * cascade into anything that reached the id in the meantime.
   */
  async createWithPhotos(
    data: { citizenid: string; account_id: number; caption: string | null },
    photos: { photo_id: number }[]
  ): Promise<number> {
    const id = await super.create(data as unknown as Partial<GlimpsePost>);
    try {
      await Database.insert(
        `INSERT INTO \`mica_glimpse_attachments\` (\`post_id\`, \`citizenid\`, \`media_id\`) VALUES ${photos
          .map(() => '(?, ?, ?)')
          .join(', ')}`,
        photos.flatMap((photo) => [id, data.citizenid, photo.photo_id])
      );
    } catch (error) {
      try {
        await this.delete(id, data.citizenid);
      } catch (undo) {
        console.error('[glimpse] Could not withdraw post', id, 'after its photos failed:', undo);
      }
      throw error;
    }
    return id;
  }

  /** `SELECT <publicColumns>`, for a handler building its own `WHERE`. */
  projection(alias?: string): string {
    const prefix = alias ? `${alias}.` : '';
    return this.publicColumns.map((column) => `${prefix}\`${column}\``).join(', ');
  }

  /** Author and carousel onto a page of rows already read through `projection()`. */
  async hydrate(rows: GlimpsePost[]): Promise<GlimpsePost[]> {
    if (rows.length === 0) return rows;
    await attachAuthors(rows);
    const photos = await this.findAttachmentsFor(rows.map((row) => row.id));
    for (const row of rows) row.attachments = photos.get(Number(row.id)) ?? [];
    return rows;
  }

  /** One live post as a reader sees it, or null — gone, moderated and missing look alike. */
  async findPublicById(id: number): Promise<GlimpsePost | null> {
    const rows = await Database.query<GlimpsePost[]>(
      `SELECT ${this.projection()} FROM \`mica_glimpse\` WHERE \`id\` = ? AND \`status\` = 'active' LIMIT 1`,
      [id]
    );
    const [row] = await this.hydrate(rows ?? []);
    return row ?? null;
  }

  /**
   * A page's photos, batched. `MediaPreview` only: `m.url` is selected so a hosted photo
   * (MICA-339's media host) renders, and a `moderated` photo drops out of the join — the post
   * stays, with that photo gone, which is also what a retention-removed photo leaves behind
   * (its attachment row cascades away with it).
   */
  async findAttachmentsFor(
    postIds: number[]
  ): Promise<Map<number, { id: number; media: MediaPreview }[]>> {
    const ids = distinctIds(postIds);
    if (ids.length === 0) return new Map();

    const rows = await Database.query<any[]>(
      `SELECT a.id, a.post_id,
              m.id AS media_id, m.kind, m.data, m.url, m.thumbnail,
              m.mime_type, m.duration_ms, m.alt_text,
              m.citizenid AS media_citizenid, m.device_id AS media_device_id
         FROM \`mica_glimpse_attachments\` a
         JOIN \`mica_media\` m ON a.media_id = m.id AND m.status <> 'moderated'
        WHERE a.post_id IN (${ids.map(() => '?').join(', ')})
        ORDER BY a.id ASC`,
      ids
    );

    const byPost = new Map<number, { id: number; media: MediaPreview }[]>();
    for (const row of rows ?? []) {
      // Opened off the photo's own phone, which the join selected for this alone (MICA-431).
      const media = openRow('mica_media', joinedMedia(row));
      const postId = Number(row.post_id);
      const list = byPost.get(postId) ?? [];
      list.push({
        id: row.id,
        media: {
          id: row.media_id,
          kind: row.kind ?? 'photo',
          // A `mediumtext` can arrive as a Buffer, which crosses NUI as `{type:'Buffer'}`.
          data: media.data ?? undefined,
          url: row.url ?? undefined,
          thumbnail: media.thumbnail ?? undefined,
          mime_type: row.mime_type ?? undefined,
          duration_ms: row.duration_ms ?? undefined,
          alt_text: media.alt_text ?? undefined
        }
      });
      byPost.set(postId, list);
    }
    return byPost;
  }
}
