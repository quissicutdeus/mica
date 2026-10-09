// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { MESSAGE_BODY_MAX } from '@mica/shared/contracts/messages';
import { sealRow, storablePlaintext } from '../contentCipher';
import { Database, type TransactionQuery } from '../Database';
import { hostedUrlPrefixes, quotaBytes, storedBytesOf, usedBytesQuery } from '../../services/Media';
import { isAppDisabled } from '../ownerConfig';
import { type ImportContext } from './context';
import { cutText } from './cutText';
import { SKIP, type Tally } from './report';
import { postsTarget, type ImportedAccount, type PostWrite, type PostsTarget } from './targets';

/**
 * The shared mapping (MICA-233): each source importer reads its own tables a page at a time
 * into these shapes, and everything from identity onward happens here, once, for all three.
 *
 * Every statement names micaOS's tables and columns as literals and binds every value. Rows
 * are written by the server on behalf of a resolved character, so there is no payload and no
 * `clientWritable` set in play — the ownership predicate is the citizenid the row is written
 * under, and it only ever comes out of `Resolver`.
 *
 * Every new row goes through `Ledger.write`, which commits it with its ledger row in chunks;
 * a writer's counts are final only after `ctx.ledger.flush()`, which each one calls last.
 */

/** A row's owner as the source knows it: an identifier, a phone number, or both. */
export interface OwnerRef {
  citizenid?: string | null;
  number?: string | null;
}

type Pages<T> = AsyncIterable<readonly T[]>;

/** The phone id to write, on apply. `phone()` has already said the number is not someone else's. */
const phoneIdFor = async (
  ctx: ImportContext,
  citizenid: string,
  number: string | null | undefined
): Promise<string | null> => {
  const answer = await ctx.resolver.phone(citizenid, number, true);
  return answer.kind === 'ok' ? answer.phoneId : null;
};

// ─── contacts ────────────────────────────────────────────────────────────────

export interface ContactIn {
  key: string;
  owner: OwnerRef;
  firstname: string;
  lastname?: string | null;
  phone: string;
  favorite?: boolean;
}

export const importContacts = async (
  ctx: ImportContext,
  tally: Tally,
  source: Pages<ContactIn>
): Promise<void> => {
  /** What this run has already counted, so a dry run and an apply agree on duplicates. */
  const counted = new Set<string>();
  for await (const rows of source) {
    for (const row of rows) {
      tally.readRow();
      const seen = await ctx.ledger.seen(tally.table, row.key);
      if (seen) {
        tally.skip(seen);
        continue;
      }
      const phone = row.phone.trim().slice(0, 20);
      if (!phone) {
        tally.skip(SKIP.noNumber);
        continue;
      }
      const citizenid = await ctx.resolver.owner(row.owner);
      if (!citizenid) {
        tally.skip(SKIP.unresolvedOwner);
        continue;
      }
      // A natural-key guard on top of the ledger: the same number saved twice in the source,
      // or a contact the player already re-added by hand after switching phones, appears once.
      const natural = `${citizenid}\u0000${phone}`;
      if (counted.has(natural)) {
        tally.skip(SKIP.duplicateInSource);
        continue;
      }
      const existing = await Database.scalar<number | null>(
        "SELECT 1 FROM `mica_contacts` WHERE `citizenid` = ? AND `phone` = ? AND `status` = 'active' LIMIT 1",
        [citizenid, phone]
      );
      if (existing) {
        tally.skip(SKIP.alreadyInContacts);
        continue;
      }
      const onPhone = await ctx.resolver.phone(citizenid, row.owner.number, false);
      if (onPhone.kind === 'reassigned') {
        tally.skip(SKIP.numberReassigned);
        continue;
      }
      counted.add(natural);

      await ctx.ledger.write(
        tally.table,
        row.key,
        'mica_contacts',
        citizenid,
        async () => [
          {
            query: `INSERT INTO \`mica_contacts\`
               (\`citizenid\`, \`phone_id\`, \`firstname\`, \`lastname\`, \`phone\`, \`favorite\`)
             VALUES (?, ?, ?, ?, ?, ?)`,
            params: [
              citizenid,
              await phoneIdFor(ctx, citizenid, row.owner.number),
              cutText(row.firstname.trim() || phone, 50),
              row.lastname ? cutText(row.lastname, 50) : null,
              phone,
              row.favorite ? 1 : 0
            ]
          }
        ],
        (id, reason) => {
          if (id !== null) {
            tally.written++;
            return;
          }
          counted.delete(natural);
          tally.skip(reason ?? SKIP.writeFailed);
        }
      );
    }
  }
  await ctx.ledger.flush();
};

// ─── media ───────────────────────────────────────────────────────────────────

export interface MediaIn {
  key: string;
  owner: OwnerRef;
  link: string;
  isVideo?: boolean;
  at: Date | null;
}

/** The same schemes `AddMedia` accepts, and the same ones `MediaThumb` will render. */
const SAFE_URL = /^(https?:|data:image\/)/i;

/*
 * The quota is Media's own — `quotaBytes`, `storedBytesOf` and `usedBytesQuery` are imported
 * from `services/Media.ts`, so the ceiling an import is held to cannot drift from the one the
 * camera is. Both are measured against the same `hostedUrlPrefixes`, read once per run.
 */

export const importMedia = async (
  ctx: ImportContext,
  tally: Tally,
  source: Pages<MediaIn>
): Promise<void> => {
  const limit = quotaBytes();
  const prefixes = limit > 0 ? await hostedUrlPrefixes() : [];
  const used = new Map<string, number>();
  const counted = new Set<string>();

  for await (const rows of source) {
    for (const row of rows) {
      tally.readRow();
      const seen = await ctx.ledger.seen(tally.table, row.key);
      if (seen) {
        tally.skip(seen);
        continue;
      }
      const link = row.link.trim();
      if (!SAFE_URL.test(link)) {
        tally.skip(SKIP.unsafeUrl);
        continue;
      }
      const citizenid = await ctx.resolver.owner(row.owner);
      if (!citizenid) {
        tally.skip(SKIP.unresolvedOwner);
        continue;
      }

      // The same picture twice in one owner's library is one picture. Hotlinks are also checked
      // against what the gallery already holds; inline bytes only within this run, since
      // comparing a mediumtext column row by row is not a query to run per photo.
      const natural = `${citizenid}\u0000${link}`;
      if (counted.has(natural)) {
        tally.skip(SKIP.duplicateInSource);
        continue;
      }
      const isData = /^data:/i.test(link);
      if (!isData) {
        const existing = await Database.scalar<number | null>(
          "SELECT 1 FROM `mica_media` WHERE `citizenid` = ? AND `url` = ? AND `status` = 'active' LIMIT 1",
          [citizenid, link]
        );
        if (existing) {
          tally.skip(SKIP.alreadyInGallery);
          continue;
        }
      }
      const onPhone = await ctx.resolver.phone(citizenid, row.owner.number, false);
      if (onPhone.kind === 'reassigned') {
        tally.skip(SKIP.numberReassigned);
        continue;
      }

      // Inline bytes cost their length. A hotlink costs nothing, exactly as it does in Media —
      // unless it is on an image host micaOS uploads to, where it costs what a hosted photo
      // does (MICA-293). Measured on a dry run too, so the dry run reports the same refusals.
      const cost = storedBytesOf(isData ? { data: link } : { url: link }, prefixes);
      if (limit > 0 && cost > 0) {
        let current = used.get(citizenid);
        if (current === undefined) {
          const query = usedBytesQuery(citizenid, prefixes);
          current = Number((await Database.scalar<number | null>(query.sql, query.params)) ?? 0);
        }
        if (current + cost > limit) {
          used.set(citizenid, current);
          tally.skip(SKIP.overQuota);
          continue;
        }
        used.set(citizenid, current + cost);
      }
      counted.add(natural);

      await ctx.ledger.write(
        tally.table,
        row.key,
        'mica_media',
        citizenid,
        async () => [
          {
            query: `INSERT INTO \`mica_media\`
               (\`citizenid\`, \`phone_id\`, \`kind\`, \`data\`, \`url\`, \`created_at\`)
             VALUES (?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))`,
            params: [
              citizenid,
              await phoneIdFor(ctx, citizenid, row.owner.number),
              row.isVideo ? 'video' : 'photo',
              isData ? link : null,
              isData ? null : link,
              row.at
            ]
          }
        ],
        (id, reason) => {
          if (id !== null) {
            tally.written++;
            return;
          }
          counted.delete(natural);
          if (cost > 0) used.set(citizenid, (used.get(citizenid) ?? cost) - cost);
          tally.skip(reason ?? SKIP.writeFailed);
        }
      );
    }
  }
  await ctx.ledger.flush();
};

// ─── conversations and messages ──────────────────────────────────────────────

export interface MessageIn {
  key: string;
  threadKey: string;
  sender: OwnerRef;
  body: string;
  at: Date | null;
  hidden?: boolean;
}

export interface ThreadIn {
  key: string;
  isGroup: boolean;
  name?: string | null;
  /** One per member row the source holds; each is counted on the members tally, if any. */
  members: OwnerRef[];
}

interface Member {
  citizenid: string;
  phoneId: string | null;
}

type ThreadState = { id: number; members: ReadonlySet<string> } | { skip: string };

/** The 1:1 thread two phones already share, the same query `ConversationRepository` runs. */
const findOneToOne = async (phoneA: string, phoneB: string): Promise<number | null> => {
  const rows = await Database.query<{ id: number }[]>(
    `SELECT c.\`id\` FROM \`mica_messages_conversations\` c
     WHERE c.\`is_group\` = 0 AND c.\`status\` = 'active'
       AND EXISTS (SELECT 1 FROM \`mica_messages_participants\` p1
                   WHERE p1.\`conversation_id\` = c.\`id\` AND p1.\`phone_id\` = ? AND p1.\`left_at\` IS NULL)
       AND EXISTS (SELECT 1 FROM \`mica_messages_participants\` p2
                   WHERE p2.\`conversation_id\` = c.\`id\` AND p2.\`phone_id\` = ? AND p2.\`left_at\` IS NULL)
     LIMIT 1`,
    [phoneA, phoneB]
  );
  return rows?.[0]?.id ?? null;
};

/**
 * A participant of a thread being created in the same transaction, so `@mica_import_id` is its
 * id. A plain insert: the thread is new, so `conversation_phone_unique` cannot collide.
 */
const participant = (member: Member, role: 'admin' | 'member'): TransactionQuery => ({
  query: `INSERT INTO \`mica_messages_participants\`
       (\`conversation_id\`, \`citizenid\`, \`phone_id\`, \`role\`, \`status\`)
     VALUES (@mica_import_id, ?, ?, ?, 'active')`,
  params: [member.citizenid, member.phoneId, role]
});

type Retry = { thread: ThreadIn; members: Member[] };

/**
 * Conversations, their member rows, and their messages.
 *
 * `open` turns source threads into micaOS threads — linked to the 1:1 thread two phones already
 * share, or created with their participants in the same transaction as the ledger row — and
 * remembers each one's members. `messages` then writes each message into its thread, and only
 * if its sender is one of those members: a message is never put into a thread its author is
 * not in.
 */
export class Threads {
  private readonly states = new Map<string, ThreadState>();

  constructor(
    private readonly ctx: ImportContext,
    private readonly ledgerTable: string,
    private readonly threads: Tally | null,
    private readonly memberRows: Tally | null
  ) {}

  async open(source: Pages<ThreadIn>): Promise<void> {
    for await (const page of source) {
      const retry: Retry[] = [];
      for (const thread of page) await this.openOne(thread, retry);
      await this.ctx.ledger.flush();
      // A rolled-back new pair is most likely `pair_key_unique`: the two phones got a thread
      // between the lookup and the insert. Link that one if so.
      for (const { thread, members } of retry) {
        if ((await this.link(thread, members)) === null) {
          this.settle(thread.key, members, null, SKIP.writeFailed);
        }
      }
    }
  }

  private async openOne(thread: ThreadIn, retry: Retry[]): Promise<void> {
    const { ctx } = this;
    this.threads?.readRow();

    const members: Member[] = [];
    let reassigned = false;
    for (const ref of thread.members) {
      this.memberRows?.readRow();
      const citizenid = await ctx.resolver.owner(ref);
      if (!citizenid) {
        this.memberRows?.skip(SKIP.unresolvedMember);
        continue;
      }
      if (members.some((m) => m.citizenid === citizenid)) {
        this.memberRows?.skip(SKIP.duplicateInSource);
        continue;
      }
      const onPhone = await ctx.resolver.phone(citizenid, ref.number, ctx.apply);
      if (onPhone.kind === 'reassigned') {
        reassigned = true;
        this.memberRows?.skip(SKIP.numberReassigned);
        continue;
      }
      members.push({ citizenid, phoneId: onPhone.phoneId });
    }

    if (members.length < 2) {
      const reason = reassigned ? SKIP.numberReassigned : SKIP.thinThread;
      this.threads?.skip(reason);
      if (members.length > 0) this.memberRows?.skip(reason, members.length);
      this.states.set(thread.key, { skip: reason });
      return;
    }

    const existing = await ctx.ledger.lookup(this.ledgerTable, thread.key);
    if (existing !== null) {
      const reason = (await ctx.ledger.seen(this.ledgerTable, thread.key)) ?? SKIP.alreadyImported;
      this.threads?.skip(reason);
      this.memberRows?.skip(reason, members.length);
      this.states.set(thread.key, {
        id: existing,
        members: new Set(members.map((m) => m.citizenid))
      });
      return;
    }

    if (!ctx.apply) {
      const id = await ctx.ledger.record(
        this.ledgerTable,
        thread.key,
        'mica_messages_conversations',
        null,
        members[0].citizenid
      );
      this.settle(thread.key, members, id);
      return;
    }

    if ((await this.link(thread, members)) !== null) return;

    const pair =
      !thread.isGroup && members.length === 2 && members[0].phoneId !== members[1].phoneId;
    await ctx.ledger.write(
      this.ledgerTable,
      thread.key,
      'mica_messages_conversations',
      members[0].citizenid,
      async () => [
        {
          query: `INSERT INTO \`mica_messages_conversations\`
             (\`citizenid\`, \`is_group\`, \`name\`, \`participant_a\`, \`participant_b\`)
           VALUES (?, ?, ?, ?, ?)`,
          params: [
            members[0].citizenid,
            pair ? 0 : 1,
            // A group keeps the name it had. A 1:1 between two phones keeps none (MICA-339):
            // each reader labels it from their own contacts and the server never sends it.
            !pair && thread.name ? cutText(thread.name, 50) : null,
            pair ? members[0].phoneId : null,
            pair ? members[1].phoneId : null
          ]
        },
        ...members.map((m, i) => participant(m, i === 0 ? 'admin' : 'member'))
      ],
      (id, reason) => {
        if (id === null && pair && reason === SKIP.writeFailed) {
          retry.push({ thread, members });
          return;
        }
        this.settle(thread.key, members, id, reason);
      }
    );
  }

  /** Link to the 1:1 thread the pair's phones already share, if they share one. */
  private async link(thread: ThreadIn, members: readonly Member[]): Promise<number | null> {
    const [a, b] = members;
    if (thread.isGroup || members.length !== 2 || !a.phoneId || !b.phoneId) return null;
    if (a.phoneId === b.phoneId) return null;
    const existing = await findOneToOne(a.phoneId, b.phoneId);
    if (existing === null) return null;
    const id = await this.ctx.ledger.record(
      this.ledgerTable,
      thread.key,
      'mica_messages_conversations',
      existing,
      a.citizenid
    );
    if (id === null) {
      this.threads?.skip(SKIP.ledgerFailed);
      this.memberRows?.skip(SKIP.ledgerFailed, members.length);
      this.states.set(thread.key, { skip: SKIP.ledgerFailed });
      return existing;
    }
    if (this.threads) this.threads.written++;
    this.memberRows?.skip(SKIP.alreadyParticipant, members.length);
    this.states.set(thread.key, { id, members: new Set(members.map((m) => m.citizenid)) });
    return id;
  }

  private settle(
    key: string,
    members: readonly Member[],
    id: number | null,
    reason?: string
  ): void {
    if (id !== null) {
      if (this.threads) this.threads.written++;
      if (this.memberRows) this.memberRows.written += members.length;
      this.states.set(key, { id, members: new Set(members.map((m) => m.citizenid)) });
      return;
    }
    const why = reason ?? SKIP.writeFailed;
    this.threads?.skip(why);
    this.memberRows?.skip(why, members.length);
    this.states.set(key, { skip: why });
  }

  /** Count every row of a message table whose thread table cannot be used, under one reason. */
  static skipAll(tally: Tally, count: number, reason: string): void {
    tally.readRow(count);
    if (count > 0) tally.skip(reason, count);
  }

  async messages(tally: Tally, source: Pages<MessageIn>): Promise<void> {
    const { ctx } = this;
    for await (const rows of source) {
      for (const message of rows) {
        tally.readRow();
        const seen = await ctx.ledger.seen(tally.table, message.key);
        if (seen) {
          tally.skip(seen);
          continue;
        }
        const state = this.states.get(message.threadKey);
        if (!state) {
          tally.skip(SKIP.threadNotInTable);
          continue;
        }
        if ('skip' in state) {
          tally.skip(state.skip);
          continue;
        }
        if (message.hidden) {
          tally.skip(SKIP.hiddenInSource);
          continue;
        }
        const body = message.body.trim();
        if (!body) {
          tally.skip(SKIP.noText);
          continue;
        }
        const sender = await ctx.resolver.owner(message.sender);
        if (!sender) {
          tally.skip(SKIP.unresolvedSender);
          continue;
        }
        if (!state.members.has(sender)) {
          tally.skip(SKIP.senderNotMember);
          continue;
        }
        const conversationId = state.id;
        await ctx.ledger.write(
          tally.table,
          message.key,
          'mica_messages',
          sender,
          async () => {
            // Sealed as Messages seals a sent one (MICA-165): the thread and the sender are
            // known before the insert, and they are all the value's context binds.
            // Cut to Messages' own bound, what fits the column once sealed, key or not, so a
            // body written as plaintext here can always be sealed by a later backfill. A text
            // that starts like a sealed value seals like any other with a key; with none it
            // would be stored bare and refused, so `storablePlaintext` puts a zero-width space
            // in front, making room for it within the same bound.
            const row = await sealRow('mica_messages', {
              conversation_id: conversationId,
              citizenid: sender,
              message: await storablePlaintext(cutText(body, MESSAGE_BODY_MAX), MESSAGE_BODY_MAX)
            });
            // `updated_at` is the source's time too. Left to its default it is the moment of
            // the import, and a message whose `updated_at` is later than its `created_at`
            // reads as edited (`MessageRepository`), so every imported text would.
            return [
              {
                query: `INSERT INTO \`mica_messages\`
                   (\`conversation_id\`, \`citizenid\`, \`message\`, \`created_at\`, \`updated_at\`)
                 VALUES (?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), COALESCE(?, CURRENT_TIMESTAMP))`,
                params: [row.conversation_id, row.citizenid, row.message, message.at, message.at]
              }
            ];
          },
          (id, reason) => {
            if (id !== null) tally.written++;
            else tally.skip(reason ?? SKIP.writeFailed);
          }
        );
      }
    }
    await ctx.ledger.flush();
  }
}

// ─── posts ───────────────────────────────────────────────────────────────────

/**
 * Accounts and posts go to whichever app registered a `PostsTarget` (`targets.ts`): core does
 * not name the app, which is a Store add-on. `unavailable` says why nothing can take them.
 */
const postsTargetOrReason = (): { target: PostsTarget } | { reason: string } => {
  const target = postsTarget();
  if (!target) return { reason: SKIP.noPostsApp };
  if (isAppDisabled(target.app)) return { reason: SKIP.postsAppDisabled };
  return { target };
};

export interface AccountIn extends ImportedAccount {
  key: string;
  owner: OwnerRef;
}

/**
 * Account id → owning citizenid, for every account this run touched, plus the source
 * accounts whose owner could not be resolved — so a post by one of those says that, rather
 * than the vaguer "no account".
 */
export class AccountOwners extends Map<number, string> {
  readonly unresolved = new Set<string>();
}

/**
 * Give each source account an account in the posts app, as that app plans it: linked to one the
 * character already holds, created under a free handle, or — at the app's per-app cap — folded
 * into their oldest, which is written (the posts land) and also noted.
 */
export const importAccounts = async (
  ctx: ImportContext,
  tally: Tally,
  source: Pages<AccountIn>,
  owners: AccountOwners
): Promise<void> => {
  const available = postsTargetOrReason();
  for await (const rows of source) {
    for (const row of rows) {
      tally.readRow();
      if ('reason' in available) {
        tally.skip(available.reason);
        continue;
      }
      const { target } = available;
      const seen = await ctx.ledger.seen(tally.table, row.key);
      if (seen) {
        tally.skip(seen);
        continue;
      }
      const citizenid = await ctx.resolver.owner(row.owner);
      if (!citizenid) {
        tally.skip(SKIP.unresolvedOwner);
        owners.unresolved.add(`${tally.table}\u0000${row.key}`);
        continue;
      }
      const plan = await target.planAccount(citizenid, row);
      if (plan === 'none') {
        tally.skip(SKIP.noHandle);
        continue;
      }
      if ('link' in plan) {
        const id = await ctx.ledger.record(
          tally.table,
          row.key,
          target.accountTable,
          plan.link,
          citizenid
        );
        if (id === null) {
          tally.skip(SKIP.ledgerFailed);
          continue;
        }
        owners.set(id, citizenid);
        tally.written++;
        if (plan.folded) tally.skip(SKIP.foldedAtCap);
        continue;
      }
      await ctx.ledger.write(
        tally.table,
        row.key,
        target.accountTable,
        citizenid,
        async () => [plan.create],
        (id, reason) => {
          if (id === null) {
            tally.skip(reason ?? SKIP.writeFailed);
            return;
          }
          owners.set(id, citizenid);
          tally.written++;
        }
      );
    }
  }
  await ctx.ledger.flush();
};

export interface PostIn {
  key: string;
  /** The ledger table and key of the account that wrote it. */
  account: { table: string; key: string };
  body: string;
  at: Date | null;
  replyToKey?: string | null;
  mouthOfKey?: string | null;
  hidden?: boolean;
}

/**
 * Posts, in the order the source pages them — oldest first — so a reply's parent is always
 * written before it. A parent still in the write queue is flushed by `lookup` first.
 */
export const importPosts = async (
  ctx: ImportContext,
  tally: Tally,
  source: Pages<PostIn>,
  owners: AccountOwners
): Promise<void> => {
  const available = postsTargetOrReason();
  const roots = new Map<number, number>();

  for await (const rows of source) {
    for (const row of rows) {
      tally.readRow();
      if ('reason' in available) {
        tally.skip(available.reason);
        continue;
      }
      const { target } = available;
      const seen = await ctx.ledger.seen(tally.table, row.key);
      if (seen) {
        tally.skip(seen);
        continue;
      }
      if (row.hidden) {
        tally.skip(SKIP.hiddenInSource);
        continue;
      }
      const accountId = await ctx.ledger.lookup(row.account.table, row.account.key);
      if (accountId === null) {
        tally.skip(
          owners.unresolved.has(`${row.account.table}\u0000${row.account.key}`)
            ? SKIP.unresolvedOwner
            : SKIP.noAccount
        );
        continue;
      }
      const body = row.body.trim();
      if (body.length > target.maxBody) {
        tally.skip(SKIP.bodyTooLong);
        continue;
      }
      const replyTo = row.replyToKey ? await ctx.ledger.lookup(tally.table, row.replyToKey) : null;
      const mouthOf = row.mouthOfKey ? await ctx.ledger.lookup(tally.table, row.mouthOfKey) : null;
      if (!body && mouthOf === null) {
        tally.skip(SKIP.noText);
        continue;
      }

      let citizenid = owners.get(accountId) ?? null;
      if (!citizenid && accountId > 0) {
        citizenid = await target.ownerOf(accountId);
        if (citizenid) owners.set(accountId, citizenid);
      }
      if (!citizenid) {
        tally.skip(SKIP.noAccount);
        continue;
      }

      // The repeat is unique per account: asked first, because inside a transaction a
      // duplicate-key failure comes back only as a rollback, with nothing to say which.
      if (ctx.apply && mouthOf !== null && (await target.repeats(accountId, mouthOf))) {
        tally.skip(SKIP.duplicateMouth);
        continue;
      }

      let rootId: number | null = null;
      if (ctx.apply && replyTo !== null) {
        rootId = roots.get(replyTo) ?? (await target.rootOf(replyTo)) ?? replyTo;
      }
      const post: PostWrite = {
        citizenid,
        accountId,
        body: body || null,
        replyTo,
        rootId,
        mouthOf,
        at: row.at
      };
      await ctx.ledger.write(
        tally.table,
        row.key,
        target.postTable,
        citizenid,
        async () => [target.insertPost(post)],
        (id, reason) => {
          if (id === null) {
            tally.skip(reason ?? SKIP.writeFailed);
            return;
          }
          roots.set(id, rootId ?? id);
          tally.written++;
        }
      );
    }
  }
  await ctx.ledger.flush();
};

/** Map each page of source rows into the shape a writer takes. */
export async function* mapPages<A, B>(
  source: AsyncIterable<readonly A[]>,
  fn: (row: A) => B
): AsyncGenerator<B[]> {
  for await (const page of source) yield page.map(fn);
}
