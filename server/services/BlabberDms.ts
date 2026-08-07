import { defineService } from '../lib/defineService';
import { Database } from '../lib/Database';
import { appEventChannel } from '../lib/appEvents';
import { ownedAccount } from './Accounts';
import { BlabberDm } from '@shared/types';
import { fields, optionalString, requirePositiveInt } from '../lib/payload';
import { buildDeepLink } from '@shared/deepLink';

const APP = 'blabber';

/**
 * Direct messages in Blabber. **Strictly one to one.**
 *
 * Enforced by construction rather than by a rule: two account columns on the row and no
 * participants table, so there is no shape a third person could be added to. Contrast
 * Conversations, which needs a join table precisely because a thread there can grow — and pays
 * for it with `left_at`, roles, and a membership predicate in every query.
 *
 * `access` mirrors Conversations for the same reason: the row genuinely has an owner (the
 * sender), so writes are ownership-scoped, while *visibility* belongs to both parties and is
 * therefore custom. Two axes could not say that as one `scope`.
 *
 * Identity here is the **account**, not the citizenid — a player messages `@ada`, not a
 * character. That is what makes DMs work between alts without either side learning who is
 * behind the other.
 */
export const blabberDms = defineService<BlabberDm>({
  id: 'blabber_dms',
  table: 'gphone_blabber_dms',
  access: { read: 'owner', write: 'owner' },
  statuses: ['active', 'deleted', 'moderated'],
  schema: {
    from_account: {
      type: 'int',
      notNull: true,
      clientWritable: false,
      references: { table: 'gphone_accounts', column: 'id' }
    },
    to_account: {
      type: 'int',
      notNull: true,
      clientWritable: false,
      references: { table: 'gphone_accounts', column: 'id' }
    },
    /** Longer than a Blab: a DM is a conversation, not a broadcast. */
    body: { type: 'string', length: 500, notNull: true },
    /** Null until the recipient opens the thread. Server-set; never a client's to claim. */
    read_at: { type: 'timestamp', clientWritable: false }
  },
  indexes: [
    // Both directions, because a thread is the union of the two. InnoDB appends the primary key,
    // so each of these is already ordered by id for the paged read.
    { name: 'from_to', columns: ['from_account', 'to_account'] },
    { name: 'to_from', columns: ['to_account', 'from_account'] },
    // Unread counts per sender, for the inbox.
    { name: 'to_unread', columns: ['to_account', 'read_at'] }
  ],
  options: {
    disableGet: true, // Custom: a thread is the union of both directions.
    disableCreate: true, // Custom: verifies the sending account and notifies the recipient.
    disableUpdate: true // A sent message is not editable. There is nothing to update.
  }
});

const app = blabberDms.app;
const repo = blabberDms.repo;
const channel = appEventChannel(APP);

/** Every Blabber account this player holds. The set a DM may be sent from, or read as. */
const myAccounts = async (citizenid: string): Promise<number[]> => {
  const rows = await Database.query<{ id: number }[]>(
    "SELECT `id` FROM `gphone_accounts` WHERE `citizenid` = ? AND `app` = ? AND `status` = 'active'",
    [citizenid, APP]
  );
  return rows.map((row) => row.id);
};

/**
 * One thread: every message between two accounts, newest first.
 *
 * Authorised by owning **one side of it**, which is the 1:1 equivalent of a membership check.
 * Without it a client walks account ids and reads anyone's messages.
 */
app.registerEvent('get', async (source, cbId, data, citizenid) => {
  const body = fields(data);
  const mine = await ownedAccount(body.account_id, citizenid, APP);
  if (!mine) throw new Error('That account is not yours.');

  const peer = requirePositiveInt(body.peer_account_id, 'peer account id');
  const limit = Math.min(
    typeof body.limit === 'number' && Number.isInteger(body.limit) && body.limit > 0
      ? body.limit
      : 40,
    80
  );
  const cursor =
    body.cursor === undefined || body.cursor === null
      ? null
      : requirePositiveInt(body.cursor, 'cursor');

  const params: unknown[] = [mine.id, peer, peer, mine.id];
  const cursorClause = cursor === null ? '' : ' AND `id` < ?';
  if (cursor !== null) params.push(cursor);
  params.push(limit + 1);

  const rows = await Database.query<BlabberDm[]>(
    `SELECT * FROM \`gphone_blabber_dms\`
     WHERE ((\`from_account\` = ? AND \`to_account\` = ?)
        OR (\`from_account\` = ? AND \`to_account\` = ?))
       AND \`status\` = 'active'${cursorClause}
     ORDER BY \`id\` DESC
     LIMIT ?`,
    params
  );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return { rows: page, nextCursor: hasMore ? page[page.length - 1].id : null };
});

/**
 * The inbox: one row per correspondent, most recently active first.
 *
 * `MAX(id)` grouped by peer rather than fetching every message and reducing in the client — an
 * inbox is small, the message history behind it is not, and pulling all of it across NUI to
 * throw most of it away is the shape that stops working quietly at scale.
 */
app.registerEvent('threads', async (source, cbId, data, citizenid) => {
  const accounts = await myAccounts(citizenid);
  if (accounts.length === 0) return [];

  const list = accounts.map(() => '?').join(', ');

  /**
   * `peer` is "whichever side is not mine". Expressed with IF rather than two queries because
   * the grouping has to happen across both directions at once — a thread is the union.
   */
  const heads = await Database.query<{ peer: number; last_id: number }[]>(
    `SELECT IF(\`from_account\` IN (${list}), \`to_account\`, \`from_account\`) AS peer,
            MAX(\`id\`) AS last_id
     FROM \`gphone_blabber_dms\`
     WHERE (\`from_account\` IN (${list}) OR \`to_account\` IN (${list}))
       AND \`status\` = 'active'
     GROUP BY peer
     ORDER BY last_id DESC
     LIMIT 50`,
    [...accounts, ...accounts, ...accounts]
  );
  if (heads.length === 0) return [];

  const lastIds = heads.map((row) => Number(row.last_id));
  const messages = await Database.query<BlabberDm[]>(
    `SELECT * FROM \`gphone_blabber_dms\` WHERE \`id\` IN (${lastIds.map(() => '?').join(', ')})`,
    lastIds
  );

  const peerIds = heads.map((row) => Number(row.peer));
  const peers = await Database.query<{ id: number; handle: string; display_name: string | null }[]>(
    `SELECT \`id\`, \`handle\`, \`display_name\` FROM \`gphone_accounts\`
     WHERE \`id\` IN (${peerIds.map(() => '?').join(', ')})`,
    peerIds
  );

  const unread = await Database.query<{ from_account: number; total: number }[]>(
    `SELECT \`from_account\`, COUNT(*) AS total FROM \`gphone_blabber_dms\`
     WHERE \`to_account\` IN (${list}) AND \`read_at\` IS NULL AND \`status\` = 'active'
     GROUP BY \`from_account\``,
    accounts
  );

  const byId = new Map(messages.map((row) => [Number(row.id), row]));
  const peerById = new Map(peers.map((row) => [Number(row.id), row]));
  const unreadBy = new Map(unread.map((row) => [Number(row.from_account), Number(row.total)]));

  return heads.map((head) => {
    const peer = peerById.get(Number(head.peer));
    return {
      peer_account_id: Number(head.peer),
      handle: peer?.handle ?? null,
      display_name: peer?.display_name ?? null,
      last: byId.get(Number(head.last_id)) ?? null,
      unread: unreadBy.get(Number(head.peer)) ?? 0
    };
  });
});

app.registerEvent('send', async (source, cbId, data, citizenid) => {
  const body = fields(data);
  const text = optionalString(body.body)?.trim();
  if (!text) throw new Error('A message needs something in it.');

  const mine = await ownedAccount(body.account_id, citizenid, APP);
  if (!mine) throw new Error('That account is not yours to send from.');

  const peerId = requirePositiveInt(body.peer_account_id, 'peer account id');
  if (peerId === mine.id) throw new Error('You cannot message yourself.');

  /**
   * The recipient has to exist and be a Blabber account. Checked rather than trusted, because
   * `peer_account_id` is client-chosen and an unchecked one writes a row pointing at nothing —
   * or at an account in another app's namespace.
   */
  const peer = await Database.single<{ id: number; citizenid: string; handle: string }>(
    `SELECT \`id\`, \`citizenid\`, \`handle\` FROM \`gphone_accounts\`
     WHERE \`id\` = ? AND \`app\` = ? AND \`status\` = 'active' LIMIT 1`,
    [peerId, APP]
  );
  if (!peer) throw new Error('No such account.');

  const id = await repo.create({
    citizenid,
    from_account: mine.id,
    to_account: peer.id,
    body: text
  } as Partial<BlabberDm>);

  /**
   * Tell them, and never let telling them fail the send.
   *
   * The row is committed either way, so the recipient gets it from the ordinary thread fetch
   * even when offline — which is why nothing is queued. Same rule as `deliverToParticipants`.
   */
  const outcome = channel.push(
    peer.citizenid,
    'dm',
    { peer_account_id: mine.id, handle: mine.handle },
    {
      notify: {
        type: 'message',
        title: `@${mine.handle}`,
        message: text.slice(0, 120)
      } as never,
      kind: 'dm',
      // A DM notification had no destination at all, so tapping it did nothing whichever
      // route it came through. The thread is keyed on the peer's handle.
      deepLink: buildDeepLink('blabber', { dmHandle: mine.handle })
    }
  );
  if (!outcome.delivered && outcome.reason !== 'offline') {
    console.error(`[blabber_dms] Notification for ${id} was refused: ${outcome.reason}.`);
  }

  return {
    id,
    from_account: mine.id,
    to_account: peer.id,
    body: text,
    read_at: null,
    status: 'active'
  };
});

/**
 * Mark a correspondent's messages read.
 *
 * Scoped to rows addressed **to** an account the caller owns, so the WHERE clause is the
 * authorization: there is no id a player can pass that clears somebody else's unread count.
 */
app.registerEvent('read', async (source, cbId, data, citizenid) => {
  const body = fields(data);
  const mine = await ownedAccount(body.account_id, citizenid, APP);
  if (!mine) throw new Error('That account is not yours.');

  const peer = requirePositiveInt(body.peer_account_id, 'peer account id');
  return await Database.update(
    `UPDATE \`gphone_blabber_dms\` SET \`read_at\` = CURRENT_TIMESTAMP
     WHERE \`to_account\` = ? AND \`from_account\` = ? AND \`read_at\` IS NULL`,
    [mine.id, peer]
  );
});
