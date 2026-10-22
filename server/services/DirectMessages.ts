// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PlayerFacingError } from '../lib/errors';
import { defineService } from '../lib/defineService';
import { Database } from '../lib/Database';
import { appEventChannel, type AppEventChannel } from '../lib/appEvents';
import { openRows } from '../lib/contentCipher';
import { appDisabledError, isAppDisabled } from '../lib/ownerConfig';
import {
  ownedAccount,
  accountHasBlocked,
  accountsByIds,
  accountsOwnedBy,
  activeAccount,
  accounts as accountsService
} from './Accounts';
import type { Account, DirectMessage } from '@mica/shared/types';
import { dmsContract } from '@mica/shared/contracts/dms';
import { OPEN_REPORT, parseRetentionDays, registerRetention } from '../lib/contentRetention';
import { recordOwnerDeletion } from '../lib/moderation';
import { traceOf } from '../lib/sqlErrors';

/**
 * Direct messages between two accounts on the shared identity layer, for **any** social app
 * (MICA-390). **Strictly one to one.**
 *
 * This was Blabber's `blabber_dms`, hard-wired to Blabber's id. The app is now a payload field
 * on every action, and what differs per app — who may message whom, and what the notification
 * says — is a policy the app registers (`registerDmPolicy`). An app with no policy is refused:
 * `data.app` is the payload's, so default-allow would open DMs in any app id a client names.
 * What is the same for every app stays here: owning the sending account, the peer being an
 * active account in the same app, no messaging yourself, and a block in either direction.
 *
 * No `app:` on the declaration, the way `accounts` has none: several apps share it, so one
 * being off must not refuse the others. Each handler asks `isAppDisabled(data.app)` instead.
 *
 * The table keeps the name `mica_blabber_dms`: `contentCipher` binds every sealed body to its
 * table, and `mica_reports.target_table` and `mica_account_reactions.target_table` hold it too.
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
export const directMessages = defineService<DirectMessage, typeof dmsContract>({
  contract: dmsContract,
  id: 'dms',
  reportable: { label: 'Direct message', previewColumn: 'body' },
  /**
   * A DM takes a reaction from one of its two ends, while it is up, and not across a block in
   * either direction — the same rule `send` holds a new message to, since a reaction is also
   * something written into the other side's thread (MICA-339). Any app's DM, since the account
   * is already proven the caller's in the app the payload named. Moved here from Accounts'
   * hand-kept lists (MICA-391); the SQL is unchanged.
   */
  reactable: {
    label: 'Direct message',
    canReact: async (account, targetId) => {
      const dm = await Database.single<{ from_account: number; to_account: number } | null>(
        'SELECT `from_account`, `to_account` FROM `mica_blabber_dms` ' +
          "WHERE `id` = ? AND `status` = 'active' LIMIT 1",
        [targetId]
      );
      if (!dm || (dm.from_account !== account.id && dm.to_account !== account.id)) return false;
      const peer = dm.from_account === account.id ? dm.to_account : dm.from_account;
      return (
        !(await accountHasBlocked(account.id, peer)) && !(await accountHasBlocked(peer, account.id))
      );
    },
    /**
     * Only a DM the viewer is an end of, as one of their live accounts in the app they asked
     * as. Messages scopes its own batched read the same way, for the same reason.
     */
    visibleTo: async (ids, citizenid, appId) => {
      const rows = await Database.query<{ id: number }[]>(
        `SELECT d.\`id\` FROM \`mica_blabber_dms\` d
         WHERE d.\`id\` IN (${ids.map(() => '?').join(', ')}) AND d.\`status\` = 'active'
           AND EXISTS (SELECT 1 FROM \`mica_accounts\` a
                       WHERE a.\`citizenid\` = ? AND a.\`app\` = ? AND a.\`status\` = 'active'
                         AND a.\`id\` IN (d.\`from_account\`, d.\`to_account\`))`,
        [...ids, citizenid, appId]
      );
      return (rows ?? []).map((row) => Number(row.id));
    }
  },
  table: 'mica_blabber_dms',
  access: { read: 'owner', write: 'owner' },
  statuses: ['active', 'deleted', 'moderated'],
  /** A body is bound to the two accounts it passed between (MICA-165). */
  encryptionScope: ['from_account', 'to_account'],
  schema: {
    from_account: {
      type: 'int',
      notNull: true,
      clientWritable: false,
      references: { table: 'mica_accounts', column: 'id' }
    },
    to_account: {
      type: 'int',
      notNull: true,
      clientWritable: false,
      references: { table: 'mica_accounts', column: 'id' }
    },
    /**
     * Longer than a Blab: a DM is a conversation, not a broadcast. 500 characters of plaintext,
     * sealed at rest (MICA-165), so the column is as wide as their sealed form (migration 0007).
     */
    body: { type: 'string', length: 500, notNull: true, encrypted: true },
    /** Null until the recipient opens the thread. Server-set; never a client's to claim. */
    read_at: { type: 'timestamp', clientWritable: false }
  },
  indexes: [
    // Both directions, because a thread is the union of the two. InnoDB appends the primary key,
    // so each of these is already ordered by id for the paged read.
    { name: 'from_to', columns: ['from_account', 'to_account'] },
    { name: 'to_from', columns: ['to_account', 'from_account'] },
    // Unread counts per sender, for the inbox.
    { name: 'to_unread', columns: ['to_account', 'read_at'] },
    // The retention prune's walk (MICA-167). Additive.
    { name: 'created_at', columns: ['created_at'] }
  ],
  options: {
    disableGet: true, // Custom: a thread is the union of both directions.
    disableCreate: true, // Custom: verifies the sending account and notifies the recipient.
    disableUpdate: true, // A sent message is not editable. There is nothing to update.
    // Nor is it deletable: nothing in the app offers it, and a registered action is
    // reachable whether or not a route points at it.
    disableDelete: true
  }
});

/**
 * DM retention (MICA-167): `mica_dm_retention`, in days, **90 by default**.
 *
 * Shorter than Messages' 180: a DM is a social-media aside between accounts rather than a
 * character's phone history, and three months keeps any live conversation while letting
 * abandoned alt-account chatter go. `0` keeps DMs forever.
 *
 * A thread here is not a row — it is every DM between two accounts — so a thread whose DMs
 * have all been pruned simply stops appearing in the inbox, with nothing left behind. Its
 * reactions live in `mica_account_reactions`, keyed by table name rather than a foreign key,
 * which is why they are named here and not found from a declaration. An open report on a DM
 * holds its whole thread, and one on an account holds every DM that account sent or received.
 */
registerRetention({
  label: 'micadms',
  table: directMessages.resolved.table,
  convar: 'mica_dm_retention',
  days: () => parseRetentionDays(GetConvar('mica_dm_retention', ''), 90, 'mica_dm_retention'),
  dependents: [
    {
      table: 'mica_account_reactions',
      column: 'target_id',
      scope: { column: 'target_table', value: directMessages.resolved.table }
    }
  ],
  holds: [
    {
      // An open report on an account holds every DM it sent or received.
      sql: (row) =>
        'EXISTS (SELECT 1 FROM `mica_reports` r WHERE r.`target_table` = ? ' +
        `AND r.\`target_id\` IN (${row}.\`from_account\`, ${row}.\`to_account\`) ` +
        `AND ${OPEN_REPORT})`,
      params: [accountsService.resolved.table]
    },
    {
      // An open report on one DM holds the whole thread between those two accounts, either
      // direction. Through a DISTINCT derived table because it reads this table, which the
      // prune's DELETE targets (MySQL error 1093).
      sql: (row) =>
        'EXISTS (SELECT 1 FROM (SELECT DISTINCT d.`from_account` AS `a`, d.`to_account` AS `b` ' +
        'FROM `mica_reports` r JOIN `mica_blabber_dms` d ON d.`id` = r.`target_id` ' +
        `WHERE r.\`target_table\` = ? AND ${OPEN_REPORT}) held ` +
        `WHERE (held.\`a\` = ${row}.\`from_account\` AND held.\`b\` = ${row}.\`to_account\`) ` +
        `OR (held.\`a\` = ${row}.\`to_account\` AND held.\`b\` = ${row}.\`from_account\`))`,
      params: [directMessages.resolved.table]
    }
  ]
});

const app = directMessages.app;
const repo = directMessages.repo;

/** What a notification for a new DM says, and where tapping it goes. */
export interface DmNotice {
  title: string;
  message: string;
  /** A `buildDeepLink` string into the app the DM belongs to. */
  deepLink: string;
}

/**
 * One app's rules for its DMs. `mine` is the caller's account, `peer` the other end; both are
 * active accounts in that app, the caller owns `mine`, and neither has blocked the other — the
 * service checks all of that before it asks the policy anything.
 */
export interface DmPolicy {
  /** Whether `mine` may send `peer` a new message. A dating app answers "only after a match". */
  canSend: (mine: Account, peer: Account) => boolean | Promise<boolean>;
  /**
   * Whether `mine` may read, and mark read, its thread with `peer`. Absent means always. A
   * refusal reads as an empty thread rather than an error, so it says nothing about what is
   * there.
   */
  canRead?: (mine: Account, peer: Account) => boolean | Promise<boolean>;
  /** The notification for a DM `from` sent. `text` is the trimmed body, uncut. */
  notify: (from: Account, text: string) => DmNotice;
}

interface RegisteredPolicy {
  policy: DmPolicy;
  /** The app's own channel, so each app gets its own badge, inbox and deep link. */
  channel: AppEventChannel;
}

/** Keyed by app id. A Map, not an object: `data.app` is the payload's, `__proto__` included. */
const policies = new Map<string, RegisteredPolicy>();

/**
 * Let an app's accounts message each other. Called once, at import time, by the app's own
 * service file — `Blabber.ts` for Blabber. Throws on a second registration for the same app,
 * which would otherwise replace the first one's rules silently, and on an id that is not an
 * app id (`appEventChannel` holds the pattern).
 */
export const registerDmPolicy = (appId: string, policy: DmPolicy): void => {
  if (policies.has(appId)) {
    throw new Error(`registerDmPolicy: '${appId}' already has a DM policy.`);
  }
  if (appId !== appId.toLowerCase()) {
    throw new Error(`registerDmPolicy: '${appId}' must be lower_snake_case.`);
  }
  policies.set(appId, { policy, channel: appEventChannel(appId) });
};

/** Undo a `registerDmPolicy`: `defineSocialApp`'s rollback, and a suite's own cleanup. */
export const unregisterDmPolicy = (appId: string): void => {
  policies.delete(appId);
};

/** Test seam: the policy registered for an app, as the registry holds it. */
export const dmPolicyForTests = (appId: string): DmPolicy | undefined =>
  policies.get(appId)?.policy;

/**
 * The gate every action opens with: the app is on, and it registered a policy. Before any read,
 * so an app id nobody registered costs no query.
 */
const policyFor = (appId: string): RegisteredPolicy => {
  if (isAppDisabled(appId)) throw appDisabledError(appId);
  const registered = policies.get(appId);
  if (!registered) {
    throw new PlayerFacingError("This app doesn't support direct messages.", {
      key: 'server.dms.noPolicy'
    });
  }
  return registered;
};

/** Whether `mine` may read its thread with `peerId`, by the app's `canRead`, if it has one. */
const mayRead = async (
  policy: DmPolicy,
  mine: Account,
  peerId: number,
  appId: string
): Promise<boolean> => {
  if (!policy.canRead) return true;
  // Any status, as the inbox reads it: a deleted correspondent's history stays readable.
  const [peer] = await accountsByIds([peerId]);
  if (!peer || peer.app !== appId) return false;
  return await policy.canRead(mine, peer);
};

/**
 * Every account this player holds in one app. The set a DM may be sent from, or read as.
 *
 * Through the Accounts resolver rather than a hand-written read of its table: three services
 * were spelling the same `app = ? AND status = 'active'` predicate for themselves, and
 * "active" is the clause that decides whether a deleted account can still be messaged
 * (MICA-197).
 */
const myAccounts = async (citizenid: string, appId: string): Promise<Account[]> =>
  await accountsOwnedBy(citizenid, appId);

/**
 * A DM row as it may leave the server: without `citizenid`, whatever the query selected.
 *
 * Identity in a DM is the account, so the sender's character must never reach the other party
 * (MICA-339). `SELECT *` used to put `citizenid` on every row, and a peer reading their own
 * thread or inbox got the citizenid of whoever replied, which links one player's alts to each
 * other and to the character.
 *
 * Both reads below still **select** `citizenid`, and must: a sealed body's authenticated data
 * binds the sender's citizenid beside `from_account` and `to_account` (MICA-165), so `openRows`
 * cannot open a row without it. MICA-339 dropped it from the SQL, and every sealed DM read
 * then threw in game while the unit suite, whose stubbed rows carried the column whatever the
 * SELECT asked for, stayed green. So this strip is the only thing between the column and the
 * reply, and it runs after the open, never before.
 *
 * The lists are written out in each statement rather than shared through a constant, because
 * `encryptedColumns.test.ts` reads the SQL literal to find who touches `body`, and an
 * interpolated list hides it.
 */
const toPeerSafe = (row: DirectMessage): DirectMessage => {
  if (!('citizenid' in row)) return row;
  const safe = { ...row };
  delete safe.citizenid;
  return safe;
};

/**
 * One thread: every message between two accounts, newest first.
 *
 * Authorised by owning **one side of it**, which is the 1:1 equivalent of a membership check.
 * Without it a client walks account ids and reads anyone's messages.
 */
app.registerEvent('get', async (source, cbId, data, citizenid) => {
  const { policy } = policyFor(data.app);
  const mine = await ownedAccount(data.account_id, citizenid, data.app);
  if (!mine)
    throw new PlayerFacingError('That account is not yours.', {
      key: 'server.blabberDms.notYours'
    });

  const peer = data.peer_account_id;
  if (!(await mayRead(policy, mine, peer, data.app))) return { rows: [], nextCursor: null };
  // Clamped rather than refused: a high limit is a legitimate request with a wrong number in
  // it, which is the same call `ServiceEndpoint`'s own paging makes.
  const limit = Math.min(data.limit ?? 40, 80);
  const cursor = data.cursor ?? null;

  const params: unknown[] = [mine.id, peer, peer, mine.id];
  const cursorClause = cursor === null ? '' : ' AND `id` < ?';
  if (cursor !== null) params.push(cursor);
  params.push(limit + 1);

  // Bodies are sealed at rest (MICA-165); `citizenid` and the account columns carry each row's
  // context, so they open here. `toPeerSafe` takes `citizenid` back off before the reply.
  const rows = openRows(
    directMessages.resolved.table,
    await Database.query<DirectMessage[]>(
      `SELECT \`id\`, \`citizenid\`, \`from_account\`, \`to_account\`, \`body\`, \`read_at\`,
              \`status\`, \`created_at\`, \`updated_at\`
       FROM \`mica_blabber_dms\`
       WHERE ((\`from_account\` = ? AND \`to_account\` = ?)
          OR (\`from_account\` = ? AND \`to_account\` = ?))
         AND \`status\` = 'active'${cursorClause}
       ORDER BY \`id\` DESC
       LIMIT ?`,
      params
    )
  );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    rows: page.map(toPeerSafe),
    nextCursor: hasMore ? page[page.length - 1].id : null
  };
});

/**
 * The inbox: one row per correspondent, most recently active first.
 *
 * `MAX(id)` grouped by peer rather than fetching every message and reducing in the client — an
 * inbox is small, the message history behind it is not, and pulling all of it across NUI to
 * throw most of it away is the shape that stops working quietly at scale.
 */
app.registerEvent('threads', async (source, cbId, data, citizenid) => {
  const { policy } = policyFor(data.app);
  const owned = await myAccounts(citizenid, data.app);
  if (owned.length === 0) return [];
  const accounts = owned.map((row) => row.id);

  const list = accounts.map(() => '?').join(', ');

  /**
   * `peer` is "whichever side is not mine". Expressed with IF rather than two queries because
   * the grouping has to happen across both directions at once — a thread is the union.
   */
  const heads = await Database.query<{ peer: number; last_id: number }[]>(
    `SELECT IF(\`from_account\` IN (${list}), \`to_account\`, \`from_account\`) AS peer,
            MAX(\`id\`) AS last_id
     FROM \`mica_blabber_dms\`
     WHERE (\`from_account\` IN (${list}) OR \`to_account\` IN (${list}))
       AND \`status\` = 'active'
     GROUP BY peer
     ORDER BY last_id DESC
     LIMIT 50`,
    [...accounts, ...accounts, ...accounts]
  );
  if (heads.length === 0) return [];

  const lastIds = heads.map((row) => Number(row.last_id));
  const messages = openRows(
    directMessages.resolved.table,
    await Database.query<DirectMessage[]>(
      `SELECT \`id\`, \`citizenid\`, \`from_account\`, \`to_account\`, \`body\`, \`read_at\`,
              \`status\`, \`created_at\`, \`updated_at\`
       FROM \`mica_blabber_dms\` WHERE \`id\` IN (${lastIds.map(() => '?').join(', ')})`,
      lastIds
    )
  );

  const peerIds = heads.map((row) => Number(row.peer));
  // Not filtered to `active`: a thread with a since-deleted correspondent still has to render
  // their handle, or the row reads as messages from nobody. See `accountsByIds`.
  const peers = await accountsByIds(peerIds);

  const unread = await Database.query<{ from_account: number; total: number }[]>(
    `SELECT \`from_account\`, COUNT(*) AS total FROM \`mica_blabber_dms\`
     WHERE \`to_account\` IN (${list}) AND \`read_at\` IS NULL AND \`status\` = 'active'
     GROUP BY \`from_account\``,
    accounts
  );

  const byId = new Map(messages.map((row) => [Number(row.id), toPeerSafe(row)]));
  const peerById = new Map(peers.map((row) => [Number(row.id), row]));
  const unreadBy = new Map(unread.map((row) => [Number(row.from_account), Number(row.total)]));

  // The app's `canRead`, asked as whichever of my accounts the thread's last message is on. A
  // thread it refuses is left out, as `get` answers it empty.
  let visible = heads;
  if (policy.canRead) {
    const ownedById = new Map(owned.map((row) => [Number(row.id), row]));
    const kept: typeof heads = [];
    for (const head of heads) {
      const last = byId.get(Number(head.last_id));
      const peer = peerById.get(Number(head.peer));
      const mine =
        last &&
        (ownedById.get(Number(last.from_account)) ?? ownedById.get(Number(last.to_account)));
      if (mine && peer && peer.app === data.app && (await policy.canRead(mine, peer))) {
        kept.push(head);
      }
    }
    visible = kept;
  }

  return visible.map((head) => {
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
  const { policy, channel } = policyFor(data.app);
  // Trimmed, not capped — the contract already refused anything over the column's length, so
  // trimming can only ever shorten a body that already fits. Whitespace-only is still empty.
  const text = data.body.trim();
  if (!text)
    throw new PlayerFacingError('A message needs something in it.', {
      key: 'server.blabberDms.emptyMessage'
    });

  const mine = await ownedAccount(data.account_id, citizenid, data.app);
  if (!mine)
    throw new PlayerFacingError('That account is not yours to send from.', {
      key: 'server.blabberDms.notYoursToSend'
    });

  const peerId = data.peer_account_id;
  if (peerId === mine.id)
    throw new PlayerFacingError('You cannot message yourself.', {
      key: 'server.blabberDms.selfMessage'
    });

  /**
   * The recipient has to exist and be an account in the same app. Checked rather than trusted,
   * because `peer_account_id` is client-chosen and an unchecked one writes a row pointing at
   * nothing — or at an account in another app's namespace.
   *
   * Answered in the same words as a block or a policy refusal (MICA-255): a separate "No such
   * account" told a prober which ids are live accounts in an app, which for an unlisted app
   * (Spark) is the directory it deliberately does not have.
   */
  const peer = await activeAccount(peerId, data.app);
  if (!peer)
    throw new PlayerFacingError("You can't message this account.", {
      key: 'server.blabberDms.blocked'
    });

  /**
   * Bidirectional, unlike the feed/profile filters above: a DM has exactly two participants,
   * so either side's block ends the conversation for both — there is no "you see them, they
   * don't" reading of a private thread the way there is for a public timeline. Existing
   * history stays readable; a block doesn't retroactively hide it, only refuses a new send.
   */
  if ((await accountHasBlocked(mine.id, peer.id)) || (await accountHasBlocked(peer.id, mine.id))) {
    throw new PlayerFacingError("You can't message this account.", {
      key: 'server.blabberDms.blocked'
    });
  }

  // The app's own rule last, so it is only ever asked about two real, unblocked accounts. The
  // same words as a block: a refusal must not tell the sender which rule it was.
  if (!(await policy.canSend(mine, peer))) {
    throw new PlayerFacingError("You can't message this account.", {
      key: 'server.blabberDms.blocked'
    });
  }

  const id = await repo.create({
    citizenid,
    from_account: mine.id,
    to_account: peer.id,
    body: text
  } as Partial<DirectMessage>);

  /**
   * Tell them, and never let telling them fail the send.
   *
   * The row is committed either way, so the recipient gets it from the ordinary thread fetch
   * even when offline — which is why nothing is queued. Same rule as `deliverToParticipants`.
   *
   * The toast shows the text; the notification row it leaves behind does not (MICA-165). The
   * body is sealed in `mica_blabber_dms`, and a plaintext copy in `mica_notifications` would be
   * the same words in the same dump, so the persisted row keeps the sender and an empty body.
   *
   * On the app's own channel, so the push, the badge and the deep link are that app's. The try
   * starts after the write: a throwing `notify` must not answer a committed row as a failure.
   */
  try {
    const notice = policy.notify(mine, text);
    const outcome = channel.push(
      peer.citizenid,
      'dm',
      { peer_account_id: mine.id, handle: mine.handle },
      {
        notify: { type: 'message', title: notice.title, message: notice.message } as never,
        kind: 'dm',
        body: '',
        deepLink: notice.deepLink
      }
    );
    if (!outcome.delivered && outcome.reason !== 'offline') {
      console.error(`[dms] Notification for ${id} was refused: ${outcome.reason}.`);
    }
  } catch (error) {
    console.error(`[dms] Notification for ${id} failed:`, traceOf(error));
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

// A phone in hand, server-side: a DM reaches another player (MICA-339).
app.requirePhoneFor('send');

/**
 * Mark a correspondent's messages read.
 *
 * Scoped to rows addressed **to** an account the caller owns, so the WHERE clause is the
 * authorization: there is no id a player can pass that clears somebody else's unread count.
 */
app.registerEvent('read', async (source, cbId, data, citizenid) => {
  const { policy } = policyFor(data.app);
  const mine = await ownedAccount(data.account_id, citizenid, data.app);
  if (!mine)
    throw new PlayerFacingError('That account is not yours.', {
      key: 'server.blabberDms.notYours'
    });

  const peer = data.peer_account_id;
  if (!(await mayRead(policy, mine, peer, data.app))) return false;
  return await Database.update(
    `UPDATE \`mica_blabber_dms\` SET \`read_at\` = CURRENT_TIMESTAMP
     WHERE \`to_account\` = ? AND \`from_account\` = ? AND \`read_at\` IS NULL`,
    [mine.id, peer]
  );
});

/** Ids per statement in `deleteThread`, the retention prune's batch. */
const DELETE_BATCH = 500;

/**
 * True while an open report names any DM between the two accounts, either direction. Bound as
 * `[table, a, b, b, a]`. Through a `DISTINCT` derived table because it reads the table the
 * delete targets (MySQL error 1093) — the shape retention's thread hold above uses.
 */
const THREAD_HELD =
  'EXISTS (SELECT 1 FROM (SELECT DISTINCT r.`id` FROM `mica_reports` r ' +
  'JOIN `mica_blabber_dms` d ON d.`id` = r.`target_id` ' +
  `WHERE r.\`target_table\` = ? AND ${OPEN_REPORT} ` +
  'AND ((d.`from_account` = ? AND d.`to_account` = ?) ' +
  'OR (d.`from_account` = ? AND d.`to_account` = ?))) held)';

/**
 * Hard-delete every DM between two accounts, both directions, and the reactions on them —
 * unless an open report names any one of them, in which case **the whole thread stays**, as
 * retention holds it: a reported DM without the messages around it is evidence without its
 * context. Answers how many DMs went, `0` for a held thread.
 *
 * **A moderated DM stays, alone** (MICA-426). A takedown is a decision already made, so the
 * context around it is no longer what a reviewer needs; the row is what the ledger and the
 * actioned report point at, and what a reopen would put back. The rest of the thread goes, as
 * the app's rule says it does. The kept row's takedowns are recorded as the thread's deletion
 * (`recordOwnerDeletion`), so a reopen puts it back `deleted` — evidence still, and never one
 * lone line resurfacing in a conversation that has ended. Before the deletes and again after
 * them (`recordModerated` below), so neither a reopen nor a takedown running alongside slips by.
 *
 * For an app's own rule that a conversation ends with nothing left — an unmatch in a dating
 * app. Not reachable from any net event: a sent message is not unsendable by a player
 * (`reachability.test.ts`), and this is a server-side call an app's service makes once its own
 * rule has decided. The ids are the caller's to have checked; nothing here asks who owns them.
 *
 * Selected first and deleted by id, with the hold asked again in each delete, so a report filed
 * between the two still wins for every row not yet gone. Reactions go only for the ids actually
 * gone, as the prune does.
 */
export const deleteThread = async (a: number, b: number): Promise<number> => {
  for (const id of [a, b]) {
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new Error(`deleteThread: '${String(id)}' is not an account id.`);
    }
  }
  const table = directMessages.resolved.table;
  const held = [table, a, b, b, a];

  // The thread's moderated lines, recorded as deleted with it. Asked before the deletes, so a
  // reopen already running finishes first, and again after them, so a takedown that lands while
  // they run is recorded too. Not in a thread an open report holds: that thread stays, live,
  // and its moderated line is put back the way its siblings still are.
  const recordModerated = async (): Promise<void> => {
    const moderated = await Database.query<{ id: number }[]>(
      `SELECT t.\`id\` FROM \`mica_blabber_dms\` t
       WHERE ((t.\`from_account\` = ? AND t.\`to_account\` = ?)
          OR (t.\`from_account\` = ? AND t.\`to_account\` = ?))
         AND t.\`status\` = 'moderated' AND NOT ${THREAD_HELD}`,
      [a, b, b, a, ...held]
    );
    await recordOwnerDeletion(
      table,
      (Array.isArray(moderated) ? moderated : []).map((row) => Number(row.id))
    );
  };
  await recordModerated();

  const rows = await Database.query<{ id: number }[]>(
    `SELECT t.\`id\` FROM \`mica_blabber_dms\` t
     WHERE ((t.\`from_account\` = ? AND t.\`to_account\` = ?)
        OR (t.\`from_account\` = ? AND t.\`to_account\` = ?))
       AND t.\`status\` <> 'moderated' AND NOT ${THREAD_HELD}
     ORDER BY t.\`id\``,
    [a, b, b, a, ...held]
  );
  const ids = (Array.isArray(rows) ? rows : [])
    .map((row) => Number(row.id))
    .filter((id) => Number.isSafeInteger(id) && id > 0);

  let removed = 0;
  for (let start = 0; start < ids.length; start += DELETE_BATCH) {
    const batch = ids.slice(start, start + DELETE_BATCH);
    const marks = batch.map(() => '?').join(', ');
    const result = await Database.query<{ affectedRows?: number }>(
      `DELETE FROM \`mica_blabber_dms\` WHERE \`id\` IN (${marks})
         AND ((\`from_account\` = ? AND \`to_account\` = ?)
           OR (\`from_account\` = ? AND \`to_account\` = ?))
         AND \`status\` <> 'moderated' AND NOT ${THREAD_HELD}`,
      [...batch, a, b, b, a, ...held]
    );
    removed += Number(result?.affectedRows ?? 0) || 0;
    await Database.query(
      `DELETE FROM \`mica_account_reactions\`
       WHERE \`target_table\` = ? AND \`target_id\` IN (${marks})
         AND NOT EXISTS (SELECT 1 FROM \`mica_blabber_dms\` p
                         WHERE p.\`id\` = \`mica_account_reactions\`.\`target_id\`)`,
      [table, ...batch]
    );
  }

  await recordModerated();
  return removed;
};
