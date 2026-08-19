import { SchemaRepository, type ResolvedService } from '../lib/defineService';
import { Database } from '../lib/Database';
import { Listing, MediaPreview } from '@shared/types';

const distinctIds = (ids: number[]): number[] => [...new Set(ids)];

/**
 * Attachment hydration for Marketplace. Mirrors
 * `BlabberRepository.findAttachmentsFor` — same join, same batching by a set of
 * ids rather than one row at a time, same reason the projection excludes any
 * citizenid-shaped column: this is a public read, and the uploader's citizenid
 * would tie an image back to the listing's owner (§10).
 */
export class MarketplaceRepository extends SchemaRepository<Listing> {
  constructor(resolved: ResolvedService) {
    super(resolved);
  }

  async findAttachmentsFor(
    listingIds: number[]
  ): Promise<Map<number, { id: number; media: MediaPreview }[]>> {
    const ids = distinctIds(listingIds);
    if (ids.length === 0) return new Map();

    const placeholders = ids.map(() => '?').join(', ');
    const rows = await Database.query<any[]>(
      `SELECT a.id, a.listing_id,
              m.id AS media_id, m.kind, m.data, m.url, m.thumbnail,
              m.mime_type, m.duration_ms, m.alt_text
         FROM \`gphone_marketplace_attachments\` a
         JOIN \`gphone_media\` m ON a.media_id = m.id
        WHERE a.listing_id IN (${placeholders})
        ORDER BY a.id ASC`,
      ids
    );

    const byListing = new Map<number, { id: number; media: MediaPreview }[]>();
    for (const row of rows) {
      const list = byListing.get(row.listing_id) ?? [];
      list.push({
        id: row.id,
        media: {
          id: row.media_id,
          kind: row.kind ?? 'photo',
          data: row.data ? String(row.data) : undefined,
          url: row.url ?? undefined,
          thumbnail: row.thumbnail ? String(row.thumbnail) : undefined,
          mime_type: row.mime_type ?? undefined,
          duration_ms: row.duration_ms ?? undefined,
          alt_text: row.alt_text ?? undefined
        }
      });
      byListing.set(row.listing_id, list);
    }
    return byListing;
  }
}
