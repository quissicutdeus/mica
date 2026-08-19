import { defineService } from '../lib/defineService';
import { Listing } from '@shared/types';
import { MarketplaceRepository } from '../repositories/MarketplaceRepository';

/**
 * Marketplace: a gray-market listings feed.
 *
 * Public read (a listing has no owner-only viewers — anyone can browse the feed),
 * owner write (only the seller can transition their own listing's status), and
 * reportable through the same pipeline every other public-read table uses.
 *
 * No `account_id` the way Blabber has one: a listing has no persona to post it
 * under, so there is nothing to switch between. Semi-anonymity here is simpler than
 * Blabber's — it is just "no identity column leaves the server," which
 * `publicColumns` already gives every service for free by excluding `citizenid`.
 *
 * Editing title/price/description after posting is not supported. `write: 'owner'`
 * exists here only for the `markSold`/`remove` status transitions in the custom
 * actions below — there is no generic `update` a client can reach, and those two
 * actions are the only writes this table permits, hand-validated rather than
 * generic-CRUD.
 */
export const marketplace = defineService<Listing>({
  id: 'marketplace',
  reportable: { label: 'Listing', previewColumn: 'title' },
  access: { read: 'public', write: 'owner' },
  paging: { pageSize: 30, maxPageSize: 60 },
  // 'deleted' is required by `defineService` (the generic soft-delete target) even though
  // nothing here produces it — `disableDelete` below keeps the generic path unreachable, so
  // 'removed' (this app's own seller-initiated takedown, via the `remove` action) is the only
  // real "gone" state a listing can reach short of moderation.
  // No explicit `indexes` — every table already carries `citizenid_status`, which is exactly
  // the (owner, status) pair both `mine` and the status-transition guard below need.
  statuses: ['active', 'sold', 'removed', 'moderated', 'deleted'],
  schema: {
    title: { type: 'string', length: 100, notNull: true },
    price: { type: 'int', notNull: true },
    description: { type: 'text', notNull: true }
  },
  /**
   * Every action below is custom: `create` needs to resolve and cap attachments,
   * `markSold`/`remove` need owner + status-transition guards the generic `update`
   * cannot express, and every read needs to hydrate attachments from the child
   * table, which the generic `get` does not know exists.
   */
  options: { disableCreate: true, disableGet: true, disableUpdate: true, disableDelete: true },
  /**
   * Attachments. Identical shape to `gphone_blabber_attachments` and
   * `gphone_messages_attachments` — `media_id` rather than a bare blob, `citizenid`
   * carried for the ownership check in `resolveOwnedAttachments` and for any later
   * moderation pass, never projected back out on a public read.
   */
  childTables: [
    {
      name: 'gphone_marketplace_attachments',
      columns: {
        listing_id: {
          type: 'int',
          notNull: true,
          references: { table: 'gphone_marketplace', column: 'id' }
        },
        citizenid: {
          type: 'string',
          length: 50,
          notNull: true,
          references: { table: 'players', column: 'citizenid' }
        },
        media_id: {
          type: 'int',
          notNull: true,
          references: { table: 'gphone_media', column: 'id' }
        }
      },
      indexes: [
        { name: 'listing_id', columns: ['listing_id'] },
        { name: 'citizenid', columns: ['citizenid'] },
        { name: 'media_id', columns: ['media_id'] }
      ]
    }
  ],
  repositoryFactory: (resolved) => new MarketplaceRepository(resolved)
});
