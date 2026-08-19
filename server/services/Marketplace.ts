import { defineService } from '../lib/defineService';
import { Listing } from '@shared/types';
import { MarketplaceRepository } from '../repositories/MarketplaceRepository';
import { fields, optionalString, requirePositiveInt, pageBounds } from '../lib/payload';
import { resolveOwnedAttachments } from '../lib/attachments';
import { media } from './Media';
import { Database } from '../lib/Database';
import { resolve as resolvePlayer } from '../lib/PlayerDirectory';

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

const app = marketplace.app;
const repo = marketplace.repo as MarketplaceRepository;
const mediaRepo = media.repo;

const paging = marketplace.resolved.paging;
if (!paging) {
  throw new Error("defineService('marketplace'): a public read must declare paging.");
}

const MAX_ATTACHMENTS = 4;

/** Non-negative integer price, or throws. Zero is a legitimate "free" listing. */
const requirePrice = (raw: unknown): number => {
  if (typeof raw !== 'number' && typeof raw !== 'string') {
    throw new Error('A valid price is required.');
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error('A valid price is required.');
  }
  return value;
};

app.registerEvent('create', async (source, cbId, data, citizenid) => {
  const body = fields(data);
  const title = optionalString(body.title)?.trim();
  const description = optionalString(body.description)?.trim();
  const price = requirePrice(body.price);
  if (!title) throw new Error('A listing needs a title.');
  if (!description) throw new Error('A listing needs a description.');

  const owned = await resolveOwnedAttachments(body.attachments, citizenid, mediaRepo);
  const attachments = owned.slice(0, MAX_ATTACHMENTS);

  const id = await Database.insert(
    'INSERT INTO `gphone_marketplace` (`citizenid`, `title`, `price`, `description`, `status`) VALUES (?, ?, ?, ?, ?)',
    [citizenid, title, price, description, 'active']
  );

  for (const attachment of attachments) {
    await Database.insert(
      'INSERT INTO `gphone_marketplace_attachments` (`listing_id`, `citizenid`, `media_id`) VALUES (?, ?, ?)',
      [id, citizenid, attachment.photo_id]
    );
  }

  const attachmentsById = await repo.findAttachmentsFor([id]);

  return {
    id,
    title,
    price,
    description,
    status: 'active',
    attachments: attachmentsById.get(id) ?? []
  };
});

/**
 * One listing, public projection, for the detail screen. Also resolves the
 * seller's phone number so Call/Text can reach them — never returned as a
 * display field, only as `contactPhone`, which the client feeds straight into
 * `useCall()`/`openApp('messages', ...)` and never renders. `isOwn` lets the
 * client hide the Report button on the viewer's own listing without ever
 * seeing a citizenid to compare against — the server already knows who is
 * asking.
 */
app.registerEvent('view', async (source, cbId, data, citizenid) => {
  const id = requirePositiveInt(fields(data).id, 'listing id');
  const projection = marketplace.resolved.publicColumns.map((c) => `\`${c}\``).join(', ');
  const row = await Database.single<any>(
    `SELECT ${projection} FROM \`gphone_marketplace\` WHERE \`id\` = ? AND \`status\` = 'active'`,
    [id]
  );
  if (!row) throw new Error('That listing is no longer available.');

  const owner = await Database.single<{ citizenid: string }>(
    'SELECT `citizenid` FROM `gphone_marketplace` WHERE `id` = ?',
    [id]
  );
  const contact = owner ? await resolvePlayer(owner.citizenid) : null;

  const attachmentsById = await repo.findAttachmentsFor([id]);
  return {
    ...row,
    attachments: attachmentsById.get(id) ?? [],
    contactPhone: contact?.phone ?? null,
    isOwn: owner?.citizenid === citizenid
  };
});

app.registerEvent('feed', async (source, cbId, data) => {
  const { limit, cursor } = pageBounds(data, paging);
  const projection = marketplace.resolved.publicColumns.map((c) => `\`${c}\``).join(', ');
  const cursorClause = cursor === null ? '' : ' AND `id` < ?';

  const params: unknown[] = [];
  if (cursor !== null) params.push(cursor);
  params.push(limit + 1);

  const rows = await Database.query<any[]>(
    `SELECT ${projection} FROM \`gphone_marketplace\`
     WHERE \`status\` = 'active'${cursorClause}
     ORDER BY \`id\` DESC
     LIMIT ?`,
    params
  );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const attachmentsById = await repo.findAttachmentsFor(page.map((r) => r.id));
  for (const row of page) row.attachments = attachmentsById.get(row.id) ?? [];

  return { rows: page, nextCursor: hasMore ? page[page.length - 1].id : null };
});

app.registerEvent('search', async (source, cbId, data) => {
  const body = fields(data);
  const q = optionalString(body.q)?.slice(0, 64) ?? '';
  const { limit, cursor } = pageBounds(data, paging);
  const projection = marketplace.resolved.publicColumns.map((c) => `\`${c}\``).join(', ');
  const cursorClause = cursor === null ? '' : ' AND `id` < ?';
  const like = `%${q}%`;

  const params: unknown[] = [like, like];
  if (cursor !== null) params.push(cursor);
  params.push(limit + 1);

  const rows = await Database.query<any[]>(
    `SELECT ${projection} FROM \`gphone_marketplace\`
     WHERE \`status\` = 'active' AND (\`title\` LIKE ? OR \`description\` LIKE ?)${cursorClause}
     ORDER BY \`id\` DESC
     LIMIT ?`,
    params
  );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const attachmentsById = await repo.findAttachmentsFor(page.map((r) => r.id));
  for (const row of page) row.attachments = attachmentsById.get(row.id) ?? [];

  return { rows: page, nextCursor: hasMore ? page[page.length - 1].id : null };
});

/** The caller's own listings, every status — My Listings. Not a public read: full rows. */
app.registerEvent('mine', async (source, cbId, data, citizenid) => {
  const { limit, cursor } = pageBounds(data, paging);
  const cursorClause = cursor === null ? '' : ' AND `id` < ?';

  const params: unknown[] = [citizenid];
  if (cursor !== null) params.push(cursor);
  params.push(limit + 1);

  const rows = await Database.query<any[]>(
    `SELECT * FROM \`gphone_marketplace\`
     WHERE \`citizenid\` = ?${cursorClause}
     ORDER BY \`id\` DESC
     LIMIT ?`,
    params
  );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const attachmentsById = await repo.findAttachmentsFor(page.map((r) => r.id));
  for (const row of page) row.attachments = attachmentsById.get(row.id) ?? [];

  return { rows: page, nextCursor: hasMore ? page[page.length - 1].id : null };
});

/**
 * Shared guard for the two status-transition actions: must exist, must be owned
 * by the caller, must currently be `active`. A `sold`/`removed`/`moderated`
 * listing is a terminal state — no transition out of it through this action.
 */
const requireOwnedActiveListing = async (id: number, citizenid: string): Promise<void> => {
  const row = await Database.single<{ id: number; citizenid: string; status: string }>(
    'SELECT `id`, `citizenid`, `status` FROM `gphone_marketplace` WHERE `id` = ?',
    [id]
  );
  if (!row || row.citizenid !== citizenid) {
    throw new Error('That listing is not yours to change.');
  }
  if (row.status !== 'active') {
    throw new Error('Only an active listing can change status.');
  }
};

app.registerEvent('markSold', async (source, cbId, data, citizenid) => {
  const id = requirePositiveInt(fields(data).id, 'listing id');
  await requireOwnedActiveListing(id, citizenid);
  await Database.update("UPDATE `gphone_marketplace` SET `status` = 'sold' WHERE `id` = ?", [id]);
  return true;
});

app.registerEvent('remove', async (source, cbId, data, citizenid) => {
  const id = requirePositiveInt(fields(data).id, 'listing id');
  await requireOwnedActiveListing(id, citizenid);
  await Database.update("UPDATE `gphone_marketplace` SET `status` = 'removed' WHERE `id` = ?", [
    id
  ]);
  return true;
});
