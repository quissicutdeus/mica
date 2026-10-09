// SPDX-FileCopyrightText: 2025 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PlayerFacingError } from '../lib/errors';
import {
  ConversationRepository,
  conversationForReader,
  lastMessageForReader,
  openLineThread,
  participantForReader,
  PARTICIPANT_KEY_MAX_LENGTH,
  type ConversationRow,
  type ParticipantRow
} from '../repositories/ConversationRepository';
import { lookupLine } from '../lib/numberRegistry';
import { defineService } from '../lib/defineService';
import { AuditLogger } from '../lib/AuditLogger';
import { resolveByPhone, resolveMany } from '../lib/PlayerDirectory';
import { detectFramework } from '../lib/FrameworkBridge';
import { conversationIdFrom, pageBounds, recencyCursor } from '../lib/payload';
import { conversationsContract } from '@mica/shared/contracts/conversations';
import { phoneForCitizen, deviceForRequest } from '../lib/deviceIdentity';
import { readPhoneIdByNumber } from '../lib/phoneNumbers';
import { onDeviceHandover } from './Devices';

// Re-exported: the constant moved beside the line helpers in the repository (MICA-275).
export { PARTICIPANT_KEY_MAX_LENGTH };

/**
 * The pair-key generated column's own width (MICA-161): two sides at
 * `PARTICIPANT_KEY_MAX_LENGTH` each, joined by one separator byte that cannot appear in either — `'|'` is not a character
 * the framework bridge or `randomBytes(...).toString('hex')` ever hands back, so it cannot be
 * produced by one side alone and mistaken for the boundary between two. The sides are phone
 * ids since MICA-282 (32 hex characters), which fit the width a citizenid needed with room to
 * spare; the column is not narrowed, because a retype is a migration for nothing.
 */
const PAIR_KEY_MAX_LENGTH = PARTICIPANT_KEY_MAX_LENGTH * 2 + 1;

/**
 * Conversations: owner on both axes, with membership declared alongside.
 *
 * The row genuinely has an owner — `citizenid` is the creator. What is shared is
 * *visibility*, and that is decided by the participants join table, which every custom
 * action below checks. Rename is one of those since MICA-339: it rode the ownership-scoped
 * generic update, which asked the row's `citizenid` and so stayed with the creator after the
 * phone the thread is on changed hands. It is the custom `update` below now, authorized by the
 * admin membership on the phone in hand, and the generic one is off.
 *
 * That split is exactly why `access` has two axes rather than one `scope`: this table
 * needs ownership-scoped writes *and* membership-scoped reads at the same time, which a
 * single value could not say.
 *
 * The participants join table is declared as a child table so `pnpm generate:sql`
 * emits a complete schema: it carries `role`, a different status enum, and two
 * nullable timestamps, none of which fit the primary-table shape.
 */
export const conversations = defineService<ConversationRow, typeof conversationsContract>({
  contract: conversationsContract,
  id: 'conversations',
  table: 'mica_messages_conversations',
  access: {
    read: 'owner',
    write: 'owner',
    membership: {
      table: 'mica_messages_participants',
      foreignKey: 'conversation_id',
      // A conversation's membership is keyed on its own id.
      localKey: 'id',
      // Membership is per phone (MICA-282): the thread is on the device, and `isMember` can
      // narrow to the one in the caller's hand.
      deviceColumn: 'device_id',
      liveWhileNull: 'left_at'
    }
  },
  statuses: ['active', 'archived', 'deleted', 'moderated'],
  schema: {
    // Derived by the custom create from the resolved member count, never client-writable
    // and never read from a payload. See the note on `isGroup` in the create handler.
    is_group: { type: 'bool', notNull: true, default: 0, clientWritable: false },
    // Written by the custom `update` only (MICA-339), as the thread's admin.
    name: { type: 'string', length: 50 },
    /**
     * The two sides of a 1:1 thread, snapshotted at creation (MICA-161's half of
     * MICA-156). Null for a group thread — there is no pair for a generated column to
     * normalise — and never client-writable: the `create` handler is the only writer,
     * the same way `is_group` is. Deliberately not a foreign key onto `players`: that
     * would cascade-delete the whole thread, history included, the moment *either*
     * party's character is removed. Since MICA-300 no micaOS table has one: the purge keeps a
     * thread while another player's message is still in it.
     */
    // The two phones of a 1:1 thread since MICA-282 (citizenids before it; the migration
    // rewrites them). Width kept, because narrowing a column is a migration for nothing.
    participant_a: { type: 'string', length: PARTICIPANT_KEY_MAX_LENGTH, clientWritable: false },
    participant_b: { type: 'string', length: PARTICIPANT_KEY_MAX_LENGTH, clientWritable: false },
    /**
     * The normalised pair key `pair_key_unique` constrains. `LEAST`/`GREATEST` over the
     * columns above so the two racers in a 1:1 create — who each know "me" and "the other
     * one" in the opposite order — land on the identical string regardless of who created
     * the row.
     *
     * `NULL` in two cases, both deliberate, since a unique index treats every `NULL` as
     * distinct from every other and therefore constrains nothing between them — the same
     * technique `mica_blabber`'s `(account_id, mouth_of)` index uses for a mouth-less
     * post:
     *
     * - **A group thread.** `participant_a`/`participant_b` are both `NULL`, and `CONCAT`
     *   (so the whole expression) returns `NULL` the instant either input is, with no
     *   `CASE` needed to say so.
     * - **A non-`active` row** — admin-deleted, or a duplicate this same service's own
     *   `reconcilePairDuplicate` has already discarded. Without the `CASE`, a pair that
     *   was legitimately deleted or reconciled away would permanently block two people
     *   from ever starting a fresh 1:1 with each other again: the index does not know
     *   "used to collide," only "collides now," and a soft-deleted row still occupies it.
     *   This mirrors `findOneToOne`'s own `status = 'active'` filter, which already
     *   treats a non-active pair as not existing.
     *
     * `private: true` withholds it from the generic list projection on principle, though
     * `disableGet` below already means nothing reads through that path — the columns it is
     * built from are no more secret than what `findForCitizen`'s hydrated participant list
     * already hands every member of a thread.
     *
     * This expression used to be mirrored by hand in a migration, because a migration is
     * frozen at the moment it shipped and must not import a service module whose shape can
     * move out from under it. The flatten removed every migration, so this declaration is
     * now the only copy and `mica.sql` is generated from it — nothing to keep in sync by
     * eye. Restore the warning if a future migration ever restates this expression.
     */
    pair_key: {
      type: 'string',
      length: PAIR_KEY_MAX_LENGTH,
      clientWritable: false,
      private: true,
      generatedAs:
        "CASE WHEN `status` = 'active' " +
        "THEN CONCAT(LEAST(`participant_a`, `participant_b`), '|', GREATEST(`participant_a`, `participant_b`)) " +
        'ELSE NULL END'
    }
  },
  /**
   * The list is keyset-paged, and this is where the numbers live rather than beside the
   * handler — `pageBounds` takes a resolved `paging` for exactly that reason, so a change
   * here cannot silently miss a custom action.
   *
   * Declared on an **owner** read, which does not require it the way a public one does. It
   * is required by the shape of the data instead: a thread list has no ceiling, and before
   * MICA-197 `findForCitizen` had no `LIMIT` at all, so opening Messages cost more every
   * day a player used it. The generic `get` is disabled below, so nothing but the custom
   * handler ever consults this.
   *
   * **A screenful, since MICA-211.** It used to be 200 — far above any real list — because
   * `findForCitizen` walked the keyset on `c.id DESC` while the inbox is ordered by recency of
   * the last message, and those are different orders: an old thread somebody texts daily has a
   * low id and a recent last message, so any page smaller than the whole list dropped it out
   * of the top of the inbox until enough pages had loaded to reach it. Pinning the page above
   * the list hid that rather than fixing it. The keyset is compound now — last-message time,
   * then id — so the first page really is the newest threads and a small one is honest.
   *
   * The cap stays at 200 rather than following the default down. The two numbers answer
   * different questions: the default is what a client that asks for nothing should get, and
   * the cap is the most anything may ask for. Clamping a larger request down to a screenful
   * would refuse a legitimate one, where the cap only refuses asking for the whole history.
   */
  paging: { pageSize: 25, maxPageSize: 200 },
  indexes: [
    { name: 'citizenid_status_updated', columns: ['citizenid', 'status', 'updated_at'] },
    { name: 'updated_at', columns: ['updated_at'] },
    { name: 'pair_key_unique', columns: ['pair_key'], unique: true },
    /**
     * A job line's shared inbox (MICA-307): every thread with one line, by its `ext:` key,
     * which `openLineThread` always writes into `participant_b`. `pair_key_unique` cannot serve
     * it — `LEAST`/`GREATEST` puts the key first or second depending on the phone id — and
     * without this the read scanned every active thread on the server through `status`
     * (5,205 rows against 203 for the line's own, measured on MariaDB 11).
     */
    { name: 'participant_b_status', columns: ['participant_b', 'status'] }
  ],
  uniqueAfterDelete: {
    optOut:
      "`pair_key` is generated NULL on any row that is not 'active', and a unique key never " +
      'collides on NULL, so a deleted or reconciled-away thread already holds no key.'
  },
  childTables: [
    {
      name: 'mica_messages_participants',
      columns: {
        conversation_id: {
          type: 'int',
          notNull: true,
          references: { table: 'mica_messages_conversations', column: 'id' }
        },
        citizenid: {
          type: 'string',
          citizenId: true,
          notNull: true
        },
        /**
         * The phone this membership is on (MICA-282). A thread lives on the device: the
         * participant row names the phone, `citizenid` names whoever holds that phone now,
         * and the handover hook below moves the latter when the phone changes hands. Nullable
         * for the same reason `deviceOwned` columns are — the migration backfills it — and
         * because a child table has no repository to refuse a NULL through.
         */
        device_id: { type: 'string', length: 32 },
        role: { type: 'string', length: 20, notNull: true, default: 'member' },
        status: {
          type: 'enum',
          values: ['active', 'left', 'removed', 'moderated'],
          notNull: true,
          default: 'active'
        },
        last_read: { type: 'timestamp', notNull: true, defaultNow: true },
        created_at: { type: 'timestamp', notNull: true, defaultNow: true },
        // Null means "still in the thread" — every membership check filters on it.
        left_at: { type: 'timestamp' },
        // Archiving is per-participant: hiding a thread from your own list must not
        // hide it from everyone else's. A separate column rather than a `status`
        // value, because every membership check filters on `status = 'active'` and an
        // archived participant is still very much in the conversation.
        archived_at: { type: 'timestamp' },
        updated_at: { type: 'timestamp', notNull: true, defaultNow: true, onUpdateNow: true }
      },
      indexes: [
        { name: 'status', columns: ['status'] },
        /**
         * One row per **phone** per thread, enforced by the database rather than by the
         * code that writes it (MICA-153, re-keyed by MICA-282). A left row still holds it,
         * so the one rejoin there is — a phone opening a job line's thread it once left —
         * goes through `ensureLineParticipant` (MICA-275), which reopens the `left` row in
         * place before it would insert. Every other `addParticipant` is reached only from
         * `create`, for a thread that has just been made. Per phone rather than per person
         * because one person's two phones are two members: a thread between my burner and
         * Bob and a thread between my main phone and Bob are two threads.
         *
         * It replaces `conversation_participant_unique` on `(conversation_id, citizenid)`,
         * which `0002_phone_data_follows_the_phone` drops. The name had to change:
         * `SchemaMigrator` compares live indexes **by name only** (`server/lib/migrate.ts`),
         * so re-pointing the old one in place would have been a silent no-op on every
         * server that already has it, leaving upgraded installs permanently unlike fresh
         * ones with nothing reporting it.
         */
        {
          name: 'conversation_device_unique',
          columns: ['conversation_id', 'device_id'],
          unique: true
        },
        { name: 'device_id', columns: ['device_id'] },
        { name: 'citizenid_status', columns: ['citizenid', 'status'] },
        { name: 'conversation_status', columns: ['conversation_id', 'status'] },
        { name: 'participant_last_read', columns: ['citizenid', 'last_read'] }
      ],
      uniqueAfterDelete: {
        optOut:
          "No generic create, and a participant leaves as 'left' or 'removed', never 'deleted'. " +
          "The one rejoin, a line's thread (`ensureLineParticipant`, MICA-275), reopens the " +
          "'left' row in place before it would insert; 'removed' and 'moderated' stay refused."
      }
    }
  ],
  options: {
    disableGet: true, // Custom: hydrates participants and unread counts
    disableCreate: true, // Custom: resolves a phone number to a citizenid
    disableDelete: true, // Custom: admin soft-deletes, everyone else leaves
    disableUpdate: true // Custom: rename, as the admin through the phone in hand (MICA-339)
  },
  repositoryFactory: (resolved) => new ConversationRepository(resolved)
});

/** So other services can reach the bespoke membership queries with types intact. */
export type ConversationRepo = ConversationRepository;

const app = conversations.app;
const conversationRepo = conversations.repo as ConversationRepository;

/** Read once, so the handler and the declaration cannot disagree about the page size. */
const CONVERSATION_PAGING = conversations.resolved.paging;
if (!CONVERSATION_PAGING) {
  throw new Error("defineService('conversations'): the thread list must declare paging.");
}

/**
 * The list, and everyone in it, in **three** queries at most — regardless of how many threads
 * a player has (MICA-197).
 *
 * It was 1+N. `findForCitizen` returned every thread the player had ever been in, unbounded,
 * and then this loop issued one more query per thread to hydrate its participants. That
 * second query hard-coded `LEFT JOIN players`, which is a qb table — es_extended keeps
 * characters in `users(identifier)` — so on ESX the whole Messages list did not merely go
 * slowly, it threw, and the app was empty.
 *
 * Now: one page of threads and one `IN (…)` for that page's membership, which carries the
 * number on each member's phone. A third, batched, only on es_extended, where the number lives
 * on the character (`participantNumbers`). **No names at all since MICA-339:** the directory's
 * name and active number for each member reached every other member, which named a burner's
 * holder and gave their main number; the phone names a member from its own contacts now.
 *
 * **Why the es_extended number is not a join on the second query.** A column-to-column join
 * onto `users` is errno 1267, not a slow query: micaOS pins `utf8mb4_unicode_ci` and
 * es_extended's `users.identifier` takes the server default (`FrameworkBridge`'s note above
 * `findOfflineByCitizenIds` has it in full). `PlayerDirectory` compares against bound
 * parameters, which have no such problem.
 *
 * `participant_count` used to be a correlated subquery on every returned row, counting
 * exactly the rows the membership query now returns. It is derived rather than asked for.
 *
 * **The reply is `{ rows, nextCursor }`, not a bare array** (MICA-211, following `messages:get`
 * in MICA-212). The cursor is compound — last-message time, then id — so the client cannot
 * derive it from a row the way it derived a bare id, and it should not have to: the server knows
 * whether it truncated, and saying so costs nothing where inferring it from a short page costs an
 * empty request every time the list divides exactly by the page size. That was free while the
 * page was 200 and nobody reached it; at a screenful it is a request per player per session.
 */
app.registerEvent('get', async (source, cbId, data, citizenid) => {
  const page = pageBounds(data, CONVERSATION_PAGING, recencyCursor);
  // The thread list is the phone's, not the person's (MICA-282): the one in the caller's hand.
  const deviceId = await deviceForRequest(source, citizenid);

  // Named `list`, not `conversations`: the module-level export of that name is the
  // app handle, and shadowing it here would be a trap for the next reader.
  const { rows: list, nextCursor } = await conversationRepo.findForPhone(citizenid, deviceId, page);
  if (list.length === 0) return { rows: [], nextCursor };

  const members = await conversationRepo.findParticipantsForConversations(list.map((c) => c.id));

  const byConversation = new Map<number, ParticipantRow[]>();
  for (const row of members) {
    const held = byConversation.get(row.conversation_id);
    if (held) held.push(row);
    else byConversation.set(row.conversation_id, [row]);
  }

  const numberOf = await participantNumbers(members);

  const rows = list.map((conv) => {
    const participants = byConversation.get(conv.id) ?? [];
    return conversationForReader(conv, {
      participant_count: participants.length,
      participants: participants.map((p) =>
        participantForReader(p, citizenid, deviceId, numberOf(p))
      ),
      unread_count: Number(conv.unread_count ?? 0),
      archived_at: conv.archived_at ?? null,
      ...(conv.last_message
        ? { last_message: lastMessageForReader(conv.last_message, citizenid, participants) }
        : {})
    });
  });

  return { rows, nextCursor };
});

/**
 * The number each member is shown by, with es_extended's one exception (MICA-339).
 *
 * The number on the phone in the thread comes back with the membership read
 * (`ConversationRepository`'s `PARTICIPANT_NUMBER`). On es_extended micaOS holds no numbers at
 * all — the number is the character's, set by whatever phone-number resource the server runs,
 * and every phone they hold answers to it — so there, and only there, a member with no number
 * row is asked of the directory. Asking it anywhere else would be the bug this ticket fixed: the
 * directory's number for a citizen is the phone they hold *now*, which is a burner's holder's
 * main number.
 */
const participantNumbers = async (
  members: readonly ParticipantRow[]
): Promise<(row: ParticipantRow) => string | null> => {
  const missing = members.filter((row) => !row.phone_number).map((row) => row.citizenid);
  const directory =
    missing.length > 0 && detectFramework() === 'esx' ? await resolveMany(missing) : null;
  return (row) => row.phone_number ?? directory?.get(row.citizenid)?.phone ?? null;
};

/**
 * The most people one conversation may hold, the creator included.
 *
 * `participants` arrives as a raw client array, and every entry costs a `resolveByPhone`
 * query at create time and a net packet per message forever after
 * (`Messages.deliverToParticipants`). Unbounded, that is not a one-off cost but a
 * permanent amplifier attached to a thread. A hard constant rather than a convar, the
 * same call `proximity.MAX_NEARBY` makes: a server owner's dial belongs on things they
 * benefit from tuning, not on the ceiling for work a player can ask the server to do.
 *
 * A request over the cap is refused outright (see the check below `members` is built),
 * not silently truncated — a player who asked for 40 people and got 32 with no signal
 * which 8 were dropped would have no way to tell their group is incomplete.
 */
const MAX_CONVERSATION_MEMBERS = 32;

/**
 * The display name off the contact card the UI sometimes sends as `participant`.
 *
 * Narrowed to those two fields by the contract, which is also what stopped a bare citizenid
 * string being sent here. It was never read as one — this function returned `null` for
 * anything that was not an object — so nothing that ever worked stops working.
 */
const nameOf = (participant?: { firstname?: string; lastname?: string }): string | null => {
  const first = participant?.firstname?.trim() || undefined;
  const last = participant?.lastname?.trim() || undefined;
  return first || last ? `${first ?? ''} ${last ?? ''}`.trim() : null;
};

// Create/Start conversation
/**
 * The phone a number reaches (MICA-282): the one that owns the number, whoever holds it. A
 * number micaOS has no row for — ESX, where the framework keeps the number — falls back to
 * whichever phone its citizen is on, which on ESX is their one identity phone.
 */
const phoneForNumber = async (phone: string, citizenid: string): Promise<string> =>
  (await readPhoneIdByNumber(phone)) ?? (await phoneForCitizen(citizenid));

app.registerEvent('create', async (source, cbId, data, citizenid) => {
  // The phone this thread is being started from. A conversation is between phones (MICA-282):
  // the creator's participant row names it, the pair columns are phones, and the recipients
  // are the phones that own the numbers given.
  const ownPhoneId = await deviceForRequest(source, citizenid);

  // The client chooses every field here except `is_group`, which is derived below, so each
  // is read once into a named local with the shape it is actually allowed to have.
  // `participant` is the second exception and stays loose: the UI sends either a whole
  // contact object (used only for its display name, below) or nothing. It is never trusted
  // as a citizenid — a raw citizenid is never proof the caller knows this person (§2.9),
  // and a modified client could otherwise force its way into a thread with anyone it can
  // guess an id for. A citizenid only ever becomes a participant by resolving through a
  // phone number, the same as the 1-on-1 path.
  const phone = data.phone?.trim() || undefined;
  const requestedName = data.name?.trim() || undefined;
  const participant = data.participant;

  let targetCitizenId: string | undefined;
  /** Every member's phone, by citizenid — the creator's is the one in their hand. */
  const phoneOf = new Map<string, string>([[citizenid, ownPhoneId]]);

  /**
   * Resolve the number to a person, online or off.
   *
   * This used to be forty lines here: two direct `exports[...]` calls bypassing
   * `FrameworkBridge`, a display name assembled inline from `charinfo`, and its own
   * `JSON_EXTRACT` fallback. It also carried a real defect — on a framework object with no
   * `PlayerData` it did `targetCitizenId = targetPlayer.phone_number`, putting a **phone
   * number** where a citizenid goes, and `mica_messages_participants.citizenid` is a foreign
   * key onto `players`.
   *
   * **Only the citizenid leaves this block, and it never leaves the server** (MICA-339). The
   * resolved `displayName` used to become the thread's name and come back in the reply, which
   * made `create` a number-to-character lookup: anyone holding a burner's number got its
   * holder's real name for the price of opening a chat. A thread with a player is now named by
   * what the caller chose and nothing else; the web labels a 1:1 from the caller's own contact
   * for the number, else the number, exactly as a phone with no directory would.
   *
   * An unknown number still answers `null`, and that does say the number is not in use. Kept
   * deliberately: a real network says "not in service" too, and dialling the number already
   * tells a caller whether anyone answers. What it must not say is *who*.
   */
  if (phone) {
    const target = await resolveByPhone(phone);
    if (!target) {
      /**
       * No character holds it; a script's line may (MICA-275). A player always wins, which
       * is why this is asked second — the same order a call to the number takes. One-to-one
       * only: a line holds no participant row, so it cannot be one member of a group, and a
       * group naming it is refused below as any unknown number is.
       */
      if ((data.participants ?? []).length === 0) {
        const line = lookupLine(phone);
        if (line) {
          return conversationForReader(
            await openLineThread(conversationRepo, citizenid, ownPhoneId, {
              name: line.label,
              number: line.number
            })
          );
        }
      }
      console.log(`[Conversation] No player holds phone ${phone}; refusing to start a thread.`);
      return null;
    }
    targetCitizenId = target.citizenid;
    phoneOf.set(target.citizenid, await phoneForNumber(phone, target.citizenid));
  }

  /**
   * Everyone who will be in the thread, the creator included.
   *
   * A `Set` because the derived `is_group` below is a count of *people*, and because
   * every duplicate here used to become its own live participant row. Deduplicating the
   * phone strings would not be enough on its own — two spellings of one number resolve
   * to the same citizenid — so the collapse happens on the resolved id.
   *
   * The requested list is deduplicated *before* any of it is resolved, so a payload
   * naming one number 500 times costs one lookup rather than 500.
   */
  const uniquePhones = [...new Set(data.participants ?? [])];

  const members = new Set<string>([citizenid]);
  if (targetCitizenId) members.add(targetCitizenId);

  /**
   * Refuse an oversized request outright, before any `resolveByPhone` call is spent on it.
   *
   * A silent truncation here would let a player ask for 100 people and quietly get 32 with
   * no indication which ones were dropped — worse than telling them up front. Checked
   * against the deduplicated phone count rather than the eventual resolved-citizenid count,
   * because that count is only known after doing the resolution work this check exists to
   * avoid; the one case that costs is several spellings of the same number in a request
   * that is already at the cap, which is not worth paying per-entry lookups to get exactly
   * right.
   */
  if (uniquePhones.length + members.size > MAX_CONVERSATION_MEMBERS) {
    throw new PlayerFacingError(
      `A conversation can hold at most ${MAX_CONVERSATION_MEMBERS} people.`,
      { key: 'server.conversations.tooManyMembers', params: { max: MAX_CONVERSATION_MEMBERS } }
    );
  }

  // Group members: each entry is a phone number, resolved the same way the 1-on-1 target
  // is — never a raw citizenid, for the same reason `targetCitizenId` above isn't one.
  for (const memberPhone of uniquePhones) {
    const target = await resolveByPhone(memberPhone);
    if (!target) continue; // unknown number
    // The first number that reaches a person decides which of their phones is in the thread.
    if (!phoneOf.has(target.citizenid)) {
      phoneOf.set(target.citizenid, await phoneForNumber(memberPhone, target.citizenid));
    }
    members.add(target.citizenid);
  }

  const others = [...members].filter((member) => member !== citizenid);

  /**
   * Derived from who is actually in the thread, and never read from the payload.
   *
   * `is_group` is a fact about the row rather than a property the caller owns, and the
   * Messages UI gates every affordance that would reveal an extra participant on it —
   * the member list, the group heading, the per-message sender name. A client that could
   * set it could therefore stand a third account inside a thread the victim is shown as
   * a private DM, and the victim had no surface anywhere in the app on which to discover
   * them (MICA-153).
   *
   * Deriving it repairs `findOneToOne` at the same time. That query filters on
   * `is_group = 0`, so a forged three-party thread could be handed back as the canonical
   * pair for any two people inside it; a thread with three members can no longer claim
   * to be a pair, because nothing but the member count decides the flag.
   */
  const isGroup = others.length > 1;

  // The other side of a 1:1 thread, or null for a group (or a solo, participant-less)
  // one — there is no pair for `pair_key_unique` to constrain. Read once so the create
  // below, the pre-check, and the post-insert reconciliation all agree on it. A pair is two
  // **phones** (MICA-282): the one in the caller's hand and the one the number reaches.
  const pairCitizenId = !isGroup && others.length === 1 ? others[0] : null;
  const pairPhoneId = pairCitizenId ? (phoneOf.get(pairCitizenId) ?? null) : null;

  // Logic for 1-on-1: existing check
  if (pairPhoneId) {
    const existing = await conversationRepo.findOneToOne(ownPhoneId, pairPhoneId);
    if (existing) return conversationForReader(existing);
  }

  // Create new
  const newConv: Partial<ConversationRow> = {
    citizenid: citizenid,
    is_group: isGroup,
    // A group's name: provided, or the contact object the UI sometimes sends instead of a
    // citizenid — both the caller's own words, never the directory's name for a number.
    // **Nothing for a thread between players that is not a group** (MICA-339): each reader
    // labels a 1:1 from their own contacts and `conversationForReader` never sends its name,
    // so a stored one would only sit at rest for nobody. A line's label is written by
    // `openLineThread`, not here, and stays.
    name: isGroup ? (requestedName ?? nameOf(participant) ?? undefined) : undefined,
    // Explicit `null` rather than `undefined` for a group thread: `Repository.create`
    // builds its column list from `Object.keys`, which keeps a key set to `undefined`
    // (only `delete` or never-assigning it would drop it), and the driver underneath
    // treats `undefined` as a bind-parameter error rather than a SQL NULL. `null` is what
    // `pair_key`'s generated expression turns into a `NULL` pair key, which a unique
    // index never treats as a collision.
    participant_a: pairPhoneId ? ownPhoneId : null,
    participant_b: pairPhoneId ?? null
  };

  let conversationId: number;
  try {
    conversationId = await conversationRepo.createConversation(newConv);
  } catch (error) {
    /**
     * `pair_key_unique` refusing a genuinely simultaneous insert (MICA-161, closing the
     * gap `reconcilePairDuplicate` below narrows but cannot reach): a conversation only
     * becomes *a pair* once its participant rows exist, which is after this very insert, so
     * there was nothing for a guard on the insert to test until the pair key existed too.
     * This is the loser of that race finding out immediately rather than after the fact —
     * the winner already committed the same normalised pair, so it is there to look up
     * rather than something to reconcile. Anything else is a genuine failure and must not
     * be swallowed as though it were this one.
     */
    const message = error instanceof Error ? error.message : '';
    if (pairPhoneId && /duplicate/i.test(message)) {
      const winner = await conversationRepo.findOneToOne(ownPhoneId, pairPhoneId);
      if (winner) return conversationForReader(winner);
    }
    throw error;
  }

  await conversationRepo.addParticipant(conversationId, citizenid, ownPhoneId, 'admin');
  for (const memberCitizenId of others) {
    await conversationRepo.addParticipant(
      conversationId,
      memberCitizenId,
      phoneOf.get(memberCitizenId) ?? (await phoneForCitizen(memberCitizenId)),
      'member'
    );
  }

  /**
   * The `findOneToOne` above and the `create` below it are two round trips, and two people
   * opening a chat with each other at the same moment both miss and both create. No attacker
   * is needed; this is the ordinary case (MICA-156). Messages then split across two threads
   * with no way to merge them, because each player may hold the id the other is not writing
   * to.
   *
   * Reconciling here rather than guarding the insert, because a conversation is only *a
   * pair* once its participant rows exist — which is after the insert. By this line both
   * racers are visible to each other, and both resolve the same lowest id, so the loser
   * stands down and returns the winner. This used to only narrow the window: the residue —
   * both racers' inserts landing before either's participant rows did — needed a
   * uniquely-indexed pair key, which `pair_key_unique` now is (MICA-161). The `catch`
   * above is what actually closes that residue; this reconciliation still runs because two
   * inserts can each succeed (their pair keys committed far enough apart not to collide)
   * and still both be racing to become *the* canonical thread for this pair.
   */
  if (pairPhoneId) {
    conversationId = await conversationRepo.reconcilePairDuplicate(
      conversationId,
      ownPhoneId,
      pairPhoneId
    );
  }

  console.log(
    `[Conversation] Created conversation ${conversationId} with ${members.size} participant(s).`
  );

  // Through the reader's projection like every other answer here: the pair's phone ids and the
  // creator's citizenid are the row's, not the reply's (MICA-339).
  const now = new Date().toISOString();
  return conversationForReader({
    ...newConv,
    id: conversationId,
    created_at: now,
    updated_at: now
  } as ConversationRow);
});

/**
 * Rename a thread (MICA-339). **Only the thread's admin, on the phone in their hand.**
 *
 * The admin is the membership `create` writes for the creator, and it moves with the phone
 * when the phone changes hands (`transferParticipants`), so the person holding the phone the
 * thread was started on is the one who may rename it — not whoever started it, who may have
 * sold that phone and left. Same answer as the old owner-scoped generic update in every case
 * but that one. Other members are refused as before, with `false` and no toast; the rename UI
 * is optimistic and does not say so either.
 */
app.registerEvent('update', async (source, cbId, data, citizenid) => {
  const deviceId = await deviceForRequest(source, citizenid);
  const name = data.name.trim();
  if (!name) return false;
  return await conversationRepo.renameAsAdmin(data.id, name, citizenid, deviceId);
});

// Mark this participant's thread as read. Scoped to the caller's own membership.
app.registerEvent('read', async (source, cbId, data, citizenid) => {
  const id = conversationIdFrom(data);
  const deviceId = await deviceForRequest(source, citizenid);
  return await conversationRepo.markRead(id, citizenid, deviceId);
});

/**
 * Archive or unarchive a thread, for the caller only.
 *
 * The web has offered this from two places since Messages shipped and it reached
 * nothing — no client route, no server handler — while the browser mock answered it
 * happily. Scoped to the caller's own participant row, so the WHERE clause is the
 * authorization: there is no id a player can pass that touches someone else's view.
 */
app.registerEvent('archive', async (source, cbId, data, citizenid) => {
  const id = conversationIdFrom(data);
  const deviceId = await deviceForRequest(source, citizenid);
  // `status` is a required enum in the contract, so there is no absent case to default —
  // the old `flagUnlessFalse(data.archive)` read a flag the web never sent (MICA-208).
  return await conversationRepo.setArchived(id, citizenid, deviceId, data.status === 'archived');
});

// Delete/Leave
app.registerEvent('delete', async (source, cbId, data, citizenid) => {
  const id = conversationIdFrom(data);
  const deviceId = await deviceForRequest(source, citizenid);

  // Check role — of the membership on the phone in hand, which is the one being acted on.
  const participants = await conversationRepo.findParticipants(id);
  const self = participants.find((p) => p.citizenid === citizenid && p.device_id === deviceId);

  if (!self) {
    throw new PlayerFacingError('Not a participant', {
      key: 'server.conversations.notParticipant'
    });
  }

  /**
   * A thread with a line (MICA-223, MICA-275) has one person in it, so leaving it is deleting
   * it. Leaving the ordinary way stranded it: the line kept writing into the thread
   * (`findExternalThread` finds it by the pair columns, not by membership) and the player,
   * no longer a member, never saw another text from that number. Deleted, it frees the pair
   * key, and the line's next text opens a fresh thread the player can see.
   */
  const isLineThread = self.role !== 'admin' && (await conversationRepo.lineKeyOf(id)) !== null;

  if (self.role === 'admin' || isLineThread) {
    // Admin deletes (soft delete) on behalf of the whole thread, so this is a
    // privileged write: the actor is not necessarily the row's citizenid.
    const success = await conversationRepo.markDeletedByAdmin(id);
    if (success) {
      await AuditLogger.log({
        citizenid,
        action: 'deleted',
        service: 'conversations',
        method: 'delete',
        targetId: id,
        targetTable: 'mica_messages_conversations'
      });
    }
    return success;
  } else {
    // Insert new row with status 'left' (Left Voluntarily)
    await conversationRepo.removeParticipant(id, citizenid, deviceId, 'left');
    await AuditLogger.log({
      citizenid,
      action: 'left',
      service: 'conversations',
      method: 'delete',
      targetId: id,
      targetTable: 'mica_messages_participants'
    });
    return true;
  }
});

/**
 * A phone changed hands: its memberships now belong to whoever holds it (MICA-282).
 *
 * `mica_messages_participants` is a child table with no repository of its own, so the
 * automatic walk over `deviceKeyedRepositories` in `services/Devices.ts` cannot reach it; this
 * is the one hook that list needs. The thread stays the phone's — `device_id` and the pair
 * columns are untouched — and the person reading it is now the holder.
 */
onDeviceHandover('conversations', (deviceId, citizenid) =>
  conversationRepo.transferParticipants(deviceId, citizenid)
);
