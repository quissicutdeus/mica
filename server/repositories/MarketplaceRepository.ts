// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { SchemaRepository } from '../lib/defineService';
import { Database } from '../lib/Database';
import { joinedMedia } from '../lib/media/joined';
import { openRow } from '../lib/contentCipher';
import { Listing, MediaPreview } from '@mica/shared/types';

const distinctIds = (ids: number[]): number[] => [...new Set(ids)];

/**
 * Attachment hydration for Marketplace. Mirrors
 * `BlabberRepository.findAttachmentsFor` — same join, same batching by a set of
 * ids rather than one row at a time, same reason the projection excludes any
 * citizenid-shaped column: this is a public read, and the uploader's citizenid
 * would tie an image back to the listing's owner (§10).
 */
export class MarketplaceRepository extends SchemaRepository<Listing> {
  async findAttachmentsFor(
    listingIds: number[]
  ): Promise<Map<number, { id: number; media: MediaPreview }[]>> {
    const ids = distinctIds(listingIds);
    if (ids.length === 0) return new Map();

    const placeholders = ids.map(() => '?').join(', ');
    const rows = await Database.query<any[]>(
      `SELECT a.id, a.listing_id,
              m.id AS media_id, m.kind, m.data, m.url, m.thumbnail,
              m.mime_type, m.duration_ms, m.alt_text,
              m.citizenid AS media_citizenid, m.device_id AS media_device_id
         FROM \`mica_marketplace_attachments\` a
         JOIN \`mica_media\` m ON a.media_id = m.id
          AND m.status NOT IN ('moderated', 'expired', 'erased')
        WHERE a.listing_id IN (${placeholders})
        ORDER BY a.id ASC`,
      ids
    );

    const byListing = new Map<number, { id: number; media: MediaPreview }[]>();
    for (const row of rows) {
      // Opened off the photo's own phone, which the join selected for this alone (MICA-431).
      const media = openRow('mica_media', joinedMedia(row));
      const list = byListing.get(row.listing_id) ?? [];
      list.push({
        id: row.id,
        media: {
          id: row.media_id,
          kind: row.kind ?? 'photo',
          data: media.data ?? undefined,
          url: row.url ?? undefined,
          thumbnail: media.thumbnail ?? undefined,
          mime_type: row.mime_type ?? undefined,
          duration_ms: row.duration_ms ?? undefined,
          alt_text: media.alt_text ?? undefined
        }
      });
      byListing.set(row.listing_id, list);
    }
    return byListing;
  }
}
