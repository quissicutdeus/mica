// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PlayerFacingError } from '../lib/errors';
import { defineService } from '../lib/defineService';
import { Listing } from '@mica/shared/types';
import { MarketplaceRepository } from '../repositories/MarketplaceRepository';
import { pageBounds } from '../lib/payload';
import { marketplaceContract } from '@mica/shared/contracts/marketplace';
import { resolveOwnedAttachments } from '../lib/attachments';
import { media } from './Media';
import { Database } from '../lib/Database';
import { detectFramework, FrameworkBridge } from '../lib/FrameworkBridge';
import { deviceForRequest } from '../lib/deviceIdentity';
import { readLegacyRow, readRowByPhoneId } from '../lib/phoneNumbers';

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
export const marketplace = defineService<Listing, typeof marketplaceContract>({
  contract: marketplaceContract,
  id: 'marketplace',
  app: 'marketplace',
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
    description: { type: 'text', notNull: true },
    /**
     * The number of the phone that posted the listing, recorded at `create` (MICA-343), and
     * the only number `view` ever hands out. Before this, `view` resolved the seller's
     * *active* number at read time, so a listing posted from a burner later rang the seller's
     * main phone. The number rather than the device id: a number is what `view` returns and
     * already moves with the phone (MICA-284), it resolves on ESX where no number row
     * exists, and a device id is the very value MICA-339 keeps off every wire.
     *
     * `private`, so the feed and search projections never carry it; `view` reads it alongside
     * the owner column. Null on a listing posted before the column existed, which `view`
     * answers with no number at all rather than with whatever the seller is on today.
     */
    seller_phone: { type: 'string', length: 16, private: true, clientWritable: false }
  },
  /**
   * Every action below is custom: `create` needs to resolve and cap attachments,
   * `markSold`/`remove` need owner + status-transition guards the generic `update`
   * cannot express, and every read needs to hydrate attachments from the child
   * table, which the generic `get` does not know exists.
   */
  options: { disableCreate: true, disableGet: true, disableUpdate: true, disableDelete: true },
  /**
   * Attachments. Identical shape to `mica_blabber_attachments` and
   * `mica_messages_attachments` — `media_id` rather than a bare blob, `citizenid`
   * carried for the ownership check in `resolveOwnedAttachments` and for any later
   * moderation pass, never projected back out on a public read.
   */
  childTables: [
    {
      name: 'mica_marketplace_attachments',
      columns: {
        listing_id: {
          type: 'int',
          notNull: true,
          references: { table: 'mica_marketplace', column: 'id' }
        },
        citizenid: {
          type: 'string',
          citizenId: true,
          notNull: true
        },
        media_id: {
          type: 'int',
          notNull: true,
          references: { table: 'mica_media', column: 'id' }
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

/** `seller_phone`'s declared width, read off the declaration rather than restated. */
const SELLER_PHONE_LENGTH = (() => {
  const field = marketplace.resolved.fields.find((candidate) => candidate.name === 'seller_phone');
  if (!field?.def.length) {
    throw new Error("defineService('marketplace'): seller_phone must declare a length.");
  }
  return field.def.length;
})();

/**
 * The number, or null when there is none or the column cannot hold it. `.length` counts UTF-16
 * units, never fewer than the characters a varchar counts, so it can only refuse, never admit,
 * a value at the edge.
 */
const fitsSellerPhone = (number: string | null | undefined): string | null =>
  number && number.length <= SELLER_PHONE_LENGTH ? number : null;

/**
 * The number to record on a listing: the number of the phone in `src`'s hand, or null.
 *
 * **Not `callerNumberOf`'s rule (MICA-343).** That falls back to the framework's number when
 * the phone in hand has no number row, which is the number of whichever phone the sync last
 * settled — the main phone, for a burner whose row the sync has not written yet, or never will
 * if assignment gave up. A call carries that for one ring; a listing would store it for good.
 * So, in order:
 *
 * - **The phone's own row**, by its device id. Every item phone the sync has reached.
 * - **The framework's number on ESX**, which keeps numbers on the character and has no rows:
 *   there it is the phone's number.
 * - **The citizen's legacy row** (`device_id IS NULL`), on qb and standalone. It is the
 *   identity phone's number on a server that cannot carry a phone id, where every listing would
 *   otherwise have none. On a server that can, a legacy row exists only while no phone of the
 *   citizen's has been synced, and the first one synced takes it — so it never names a
 *   different phone of theirs.
 * - Otherwise **null**: the listing shows no Call/Text, rather than another phone's number.
 *
 * **Whatever the source, a number the column cannot hold is null too.** ESX's number is
 * whatever a community resource wrote, unchecked: one longer than `seller_phone` would make a
 * strict MariaDB refuse the insert — that player could never post — and a lax one truncate it
 * to somebody else's number. The bound is read off the declaration, so the two cannot drift.
 *
 * Never throws: a listing with no number is still a listing.
 */
const numberToRecord = async (src: number, citizenid: string): Promise<string | null> => {
  try {
    const deviceId = await deviceForRequest(src, citizenid, 'phone');
    const own = await readRowByPhoneId(deviceId);
    if (own?.number) return fitsSellerPhone(own.number);
    if (detectFramework() === 'esx') return fitsSellerPhone(FrameworkBridge.getPlayerPhone(src));
    const legacy = await readLegacyRow(citizenid);
    return fitsSellerPhone(legacy?.number);
  } catch (error) {
    if (!(error instanceof PlayerFacingError)) {
      console.error(`[marketplace] could not read the number of ${citizenid}'s phone.`, error);
    }
    return null;
  }
};

app.registerEvent('create', async (source, cbId, data, citizenid) => {
  // Trimmed rather than capped: the contract refused anything over the column's length, so
  // what is left to catch is a value that was nothing but whitespace.
  const title = data.title.trim();
  const description = data.description.trim();
  const price = data.price;
  if (!title)
    throw new PlayerFacingError('A listing needs a title.', {
      key: 'server.marketplace.titleRequired'
    });
  if (!description)
    throw new PlayerFacingError('A listing needs a description.', {
      key: 'server.marketplace.descriptionRequired'
    });

  // No `.slice()` any more: the cap is applied inside the resolver, before it does the work
  // the cap is supposed to bound (MICA-154).
  const attachments = await resolveOwnedAttachments(data.attachments, citizenid, mediaRepo);
  const sellerPhone = await numberToRecord(source, citizenid);

  const id = await Database.insert(
    'INSERT INTO `mica_marketplace` (`citizenid`, `title`, `price`, `description`, `status`, `seller_phone`) VALUES (?, ?, ?, ?, ?, ?)',
    [citizenid, title, price, description, 'active', sellerPhone]
  );

  for (const attachment of attachments) {
    await Database.insert(
      'INSERT INTO `mica_marketplace_attachments` (`listing_id`, `citizenid`, `media_id`) VALUES (?, ?, ?)',
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

// A phone in hand, server-side: a listing is published to everyone (MICA-339).
app.requirePhoneFor('create');

/**
 * One listing, public projection, for the detail screen. Also hands out the number of the
 * phone that posted it so Call/Text can reach them — never returned as a display field, only
 * as `contactPhone`, which the client feeds straight into `useCall()`/`openApp('messages', ...)`
 * and never renders. That is `seller_phone` as recorded at `create`, never the seller's number
 * today (MICA-343): a burner's listing reaches the burner. A listing from before that column
 * answers null, so it shows no Call/Text rather than a number it was not posted from.
 * `isOwn` lets the client hide the Report button on the viewer's own listing without ever
 * seeing a citizenid to compare against — the server already knows who is asking.
 */
app.registerEvent('view', async (source, cbId, data, citizenid) => {
  const id = data.id;
  const projection = marketplace.resolved.publicColumns.map((c) => `\`${c}\``).join(', ');
  const row = await Database.single<any>(
    `SELECT ${projection} FROM \`mica_marketplace\` WHERE \`id\` = ? AND \`status\` = 'active'`,
    [id]
  );
  if (!row)
    throw new PlayerFacingError('That listing is no longer available.', {
      key: 'server.marketplace.listingGone'
    });

  const owner = await Database.single<{ citizenid: string; seller_phone: string | null }>(
    'SELECT `citizenid`, `seller_phone` FROM `mica_marketplace` WHERE `id` = ?',
    [id]
  );

  const attachmentsById = await repo.findAttachmentsFor([id]);
  return {
    ...row,
    attachments: attachmentsById.get(id) ?? [],
    contactPhone: owner?.seller_phone || null,
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
    `SELECT ${projection} FROM \`mica_marketplace\`
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
  const q = data.q;
  const { limit, cursor } = pageBounds(data, paging);
  const projection = marketplace.resolved.publicColumns.map((c) => `\`${c}\``).join(', ');
  const cursorClause = cursor === null ? '' : ' AND `id` < ?';
  const like = `%${q}%`;

  const params: unknown[] = [like, like];
  if (cursor !== null) params.push(cursor);
  params.push(limit + 1);

  const rows = await Database.query<any[]>(
    `SELECT ${projection} FROM \`mica_marketplace\`
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
    `SELECT * FROM \`mica_marketplace\`
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
 *
 * **This decides what the player is told; `transitionActiveListing` decides what happens.**
 * It reads the row, so between it and a write there is a yield, and both `markSold` and
 * `remove` used to pass it concurrently and then write unconditionally — last writer wins,
 * and a listing could go `sold` after it was `removed` (MICA-132). Keeping the read is
 * still worth it: it is the only thing that can distinguish "not yours" from "already
 * settled", and a toast that says which is worth one indexed lookup.
 */
const requireOwnedActiveListing = async (id: number, citizenid: string): Promise<void> => {
  const row = await Database.single<{ id: number; citizenid: string; status: string }>(
    'SELECT `id`, `citizenid`, `status` FROM `mica_marketplace` WHERE `id` = ?',
    [id]
  );
  if (!row || row.citizenid !== citizenid) {
    throw new PlayerFacingError('That listing is not yours to change.', {
      key: 'server.marketplace.notYours'
    });
  }
  if (row.status !== 'active') {
    throw new PlayerFacingError('Only an active listing can change status.', {
      key: 'server.marketplace.notActive'
    });
  }
};

/**
 * Move a listing out of `active`, with every condition the guard checked folded into the
 * one statement that writes — ownership and the current status both, so there is no gap
 * between deciding and writing (the phrasing `Repository.applyUpdate` uses for the edit
 * window, and the same idea).
 *
 * `status` is a literal chosen by the caller in this file and never a payload value, so
 * nothing here interpolates anything a client supplied; the id and the citizenid stay
 * bound. Answers false when the row moved underneath us, which is the race losing.
 */
const transitionActiveListing = async (
  id: number,
  citizenid: string,
  next: 'sold' | 'removed'
): Promise<boolean> =>
  await Database.update(
    'UPDATE `mica_marketplace` SET `status` = ? ' +
      "WHERE `id` = ? AND `citizenid` = ? AND `status` = 'active'",
    [next, id, citizenid]
  );

app.registerEvent('markSold', async (source, cbId, data, citizenid) => {
  const id = data.id;
  await requireOwnedActiveListing(id, citizenid);
  if (!(await transitionActiveListing(id, citizenid, 'sold'))) {
    throw new PlayerFacingError('Only an active listing can change status.', {
      key: 'server.marketplace.notActive'
    });
  }
  return true;
});

app.registerEvent('remove', async (source, cbId, data, citizenid) => {
  const id = data.id;
  await requireOwnedActiveListing(id, citizenid);
  if (!(await transitionActiveListing(id, citizenid, 'removed'))) {
    throw new PlayerFacingError('Only an active listing can change status.', {
      key: 'server.marketplace.notActive'
    });
  }
  return true;
});
