// SPDX-FileCopyrightText: 2025 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { SchemaRepository } from '../lib/defineService';
import type { Conversation, Participant } from '@mica/shared/types';
import { Database } from '../lib/Database';
import {
  contentContext,
  encryptedColumn,
  isSealed,
  openContent,
  openRows,
  UNREADABLE_CONTENT
} from '../lib/contentCipher';
import { toSqlDateTime, type RecencyCursor } from '../lib/payload';
import { PHONE_NUMBERS_TABLE } from '../lib/phoneNumbers';

/**
 * A conversation as the server holds it — the row, not what a phone is shown (MICA-339).
 *
 * `citizenid` is the creator and `participant_a`/`participant_b` are the two phone ids of a 1:1
 * (or a phone id and a line's `ext:` key). All three stay here: `conversationForReader` below is
 * the one place a row becomes the wire `Conversation`, and it names none of them.
 */
export interface ConversationRow {
  id: number;
  citizenid: string;
  is_group: boolean;
  name?: string | null;
  participant_a?: string | null;
  participant_b?: string | null;
  status?: Conversation['status'];
  created_at: Date | string;
  updated_at: Date | string;
}

/** The newest live message of a thread, as `findForPhone` carries it: still the sender's row. */
export interface LastMessageRow {
  message: string;
  created_at: Date | string;
  citizenid: string;
  external_sender: string | null;
}

/** `findForPhone`'s row: the thread, plus what only the reader's own membership can say. */
export interface ConversationListRow extends ConversationRow {
  unread_count?: number;
  archived_at?: Date | string | null;
  last_message?: LastMessageRow;
}

/**
 * A membership row as the server holds it (MICA-339). `citizenid` is whoever holds the phone now
 * and `phone_id` is the phone; neither reaches another member. `phone_number` is the number on
 * that phone, read with the row — see `PARTICIPANT_NUMBER` for which number that is.
 */
export interface ParticipantRow {
  id: number;
  conversation_id: number;
  citizenid: string;
  phone_id?: string | null;
  role: Participant['role'];
  status?: Participant['status'];
  last_read: Date | string;
  created_at: Date | string;
  left_at?: Date | string | null;
  updated_at: Date | string;
  phone_number?: string | null;
}

/**
 * The number a member is shown by: the one on **the phone that is in the thread** (MICA-339).
 *
 * It used to be the directory's number for the member's citizenid — the phone they are using
 * *now* — so a thread with a burner carried its holder's main number the moment they switched
 * back, and the reader's contacts named it. Now, in order:
 *
 * 1. The number row on this membership's phone (`phone_id_unique`). Every phone a qb or
 *    standalone server has seen in use carries one (MICA-284).
 * 2. The citizen's legacy row, a number on no phone yet. That exists only on a server whose
 *    inventory cannot carry a phone id — one phone per citizen, so their number *is* this
 *    phone's — or for a citizen who has not used an id'd phone since the upgrade, whose
 *    thread can only be on their identity phone.
 * 3. Neither: null. On es_extended micaOS holds no numbers at all and the number lives on the
 *    character; `Conversations.get` asks the directory for those, and only there.
 *
 * A correlated read per member, each on a unique or leading key, over at most one page of
 * threads' members — the same bound the membership read already has.
 */
const PARTICIPANT_NUMBER =
  `COALESCE(` +
  `(SELECT n.\`number\` FROM \`${PHONE_NUMBERS_TABLE}\` n WHERE n.\`phone_id\` = p.\`phone_id\` LIMIT 1), ` +
  `(SELECT l.\`number\` FROM \`${PHONE_NUMBERS_TABLE}\` l ` +
  `WHERE l.\`citizenid\` = p.\`citizenid\` AND l.\`phone_id\` IS NULL ORDER BY l.\`id\` LIMIT 1)` +
  `) AS phone_number`;

/** Whether one side of a 1:1 is a line rather than a phone (MICA-223). */
export const isLineSide = (side: unknown): boolean =>
  typeof side === 'string' && side.startsWith(LINE_KEY_PREFIX);

/**
 * The member of this thread who sent a message, as the `Participant.id` a reader can match.
 *
 * Null for a text from a line, whose row sits under the recipient's citizenid and so would
 * otherwise name the recipient, and for a sender no longer in the thread. Matched on the
 * citizen because a message row names no phone; one person with two phones in one group is the
 * one case that cannot be told apart, and the lower membership id answers it every time.
 */
export const senderIdOf = (
  participants: readonly ParticipantRow[],
  senderCitizenId: string,
  externalSender?: string | null
): number | null => {
  if (externalSender) return null;
  let found: number | null = null;
  for (const row of participants) {
    if (row.citizenid !== senderCitizenId || row.left_at) continue;
    const id = Number(row.id);
    if (found === null || id < found) found = id;
  }
  return found;
};

/**
 * A membership row as another member of the thread is shown it (MICA-339): its own id, its role
 * and timestamps, whether it is the reader's, and the number on its phone. Built field by field,
 * so a column added to the table later is not handed to every member by a spread.
 */
export const participantForReader = (
  row: ParticipantRow,
  readerCitizenId: string,
  readerPhoneId: string,
  phone: string | null = row.phone_number ?? null
): Participant => ({
  id: Number(row.id),
  conversation_id: Number(row.conversation_id),
  role: row.role,
  status: row.status,
  last_read: row.last_read,
  created_at: row.created_at,
  left_at: row.left_at ?? null,
  updated_at: row.updated_at,
  self: row.citizenid === readerCitizenId && row.phone_id === readerPhoneId,
  phone
});

/** The inbox's preview of a thread's newest message, for one reader. */
export const lastMessageForReader = (
  row: LastMessageRow,
  readerCitizenId: string,
  participants: readonly ParticipantRow[]
): NonNullable<Conversation['last_message']> => ({
  message: row.message,
  created_at: row.created_at,
  external_sender: row.external_sender ?? null,
  mine: !row.external_sender && row.citizenid === readerCitizenId,
  sender_id: senderIdOf(participants, row.citizenid, row.external_sender)
});

/**
 * A conversation row as a member is shown it (MICA-339).
 *
 * Built field by field rather than spread, so the creator's citizenid, the pair's phone ids and
 * the generated pair key never leave — and neither does anything added to the table later.
 *
 * **A 1:1 between two phones carries no name.** The row's `name` was, until this ticket, the
 * directory's name for the number the creator dialled, and rows written then still hold it. The
 * phone never shows a 1:1 by that field anyway — it labels it from the reader's contacts for the
 * other member's number — so withholding it costs nothing and stops the stored name reaching a
 * later holder of either phone. A group keeps the name its members gave it, and a thread with a
 * line keeps the line's label, which is the only name it has.
 */
export const conversationForReader = (
  row: ConversationRow,
  extras: Partial<
    Pick<
      Conversation,
      'participants' | 'last_message' | 'unread_count' | 'participant_count' | 'archived_at'
    >
  > = {}
): Conversation => {
  const withLine = isLineSide(row.participant_a) || isLineSide(row.participant_b);
  const named = Boolean(row.is_group) || withLine;
  const now = new Date().toISOString();
  return {
    id: Number(row.id),
    is_group: Boolean(row.is_group),
    ...(named && row.name ? { name: row.name } : {}),
    status: row.status ?? 'active',
    created_at: row.created_at ?? now,
    updated_at: row.updated_at ?? now,
    ...extras
  };
};

/**
 * One player's thread with a line, as a job line's inbox reads it (MICA-307): the thread, the
 * number on the player's phone, and its newest live message, opened.
 */
export interface LineThreadRow {
  conversation_id: number;
  /** The number on the thread's phone, or null when micaOS holds none for it (ESX). */
  from_number: string | null;
  /** The newest live message's own columns. */
  id: number;
  citizenid: string;
  message: string;
  external_sender: string | null;
  created_at: unknown;
}

/**
 * The width of one side of a 1:1 thread: a phone id, or a line's `ext:` key (MICA-223).
 *
 * Its own constant since MICA-289, when a citizenid's width started to depend on the
 * framework: these columns have held phone ids since MICA-282, not citizenids, so they keep
 * the 50 they always had rather than widening with the owner key on ESX for nothing. Here
 * rather than in `Conversations.ts` since MICA-275, so the line helpers below can use it;
 * that module re-exports it.
 */
export const PARTICIPANT_KEY_MAX_LENGTH = 50;

/**
 * What marks the far side of a thread as a line rather than a phone (MICA-223). Phone ids
 * are bare hex, so no phone id can start with it.
 */
export const LINE_KEY_PREFIX = 'ext:';

/**
 * A sender that is not a player (MICA-223): a business name, a registered line, or both.
 * At least one is present; `publicApi.ts` has refused the call otherwise.
 */
export interface LineSender {
  name: string | null;
  number: string | null;
  /**
   * False only for a line registered with `blockable: false` by the resource sending as it
   * (MICA-278) — `publicApi.ts` decides that, since only it knows the invoking resource.
   * Absent means blockable: a player who blocked `number` gets no live push from it.
   */
  blockable?: boolean;
}

/**
 * The far side of a thread with a line, in the pair columns' own terms.
 *
 * A 1:1 thread is keyed on two phone ids. A line has no phone, so it gets a key that cannot
 * collide with one -- phone ids are bare hex, this carries a prefix -- built from the number
 * when there is one, else the name. Two resources texting from the same number therefore
 * share a thread, which is what a player expects of a number, and the same name with no
 * number is one thread too. Cut to the pair column's width; a label that long is truncated in
 * the thread name as well.
 */
export const lineKey = (from: LineSender): string =>
  `${LINE_KEY_PREFIX}${(from.number ?? from.name ?? '').trim().toLowerCase()}`.slice(
    0,
    PARTICIPANT_KEY_MAX_LENGTH
  );

/** What the thread and every message in it are labelled with. `name` wins when both exist. */
export const lineLabel = (from: LineSender): string =>
  (from.name ?? from.number ?? '').trim().slice(0, 50);

/**
 * The thread between a phone and a line, created if it does not exist yet (MICA-223).
 *
 * One path for both directions (MICA-275): `Messages.sendFromLine` when the line texts first,
 * and `conversations:create` when the player does, so a player who texts a line and the line
 * texting back land in the same thread. The player is its only participant — a line has no
 * `players` row — and the pair columns carry the line.
 */
export const openLineThread = async (
  repo: Pick<
    ConversationRepository,
    'findExternalThread' | 'createConversation' | 'ensureLineParticipant'
  >,
  citizenid: string,
  phoneId: string,
  from: LineSender
): Promise<ConversationRow> => {
  const key = lineKey(from);
  const label = lineLabel(from);

  const existing = await repo.findExternalThread(phoneId, key);
  if (existing) {
    // A player who left this thread before leaving deleted it (MICA-275) would otherwise
    // get it back with no membership, and every send into it would be refused.
    await repo.ensureLineParticipant(existing.id, citizenid, phoneId);
    return existing;
  }

  const created: Partial<ConversationRow> = {
    citizenid,
    is_group: false,
    name: label,
    participant_a: phoneId,
    participant_b: key
  };
  let conversationId: number;
  try {
    conversationId = await repo.createConversation(created);
  } catch (error) {
    // Two texts from the same line in the same instant: `pair_key_unique` refused the
    // second. The first one's thread is the answer.
    const winner = /duplicate/i.test(error instanceof Error ? error.message : '')
      ? await repo.findExternalThread(phoneId, key)
      : null;
    if (!winner) throw error;
    // Still added: the winner may not have written its participant row yet, and
    // `ensureLineParticipant` is a no-op when it already has.
    await repo.ensureLineParticipant(winner.id, citizenid, phoneId);
    return winner;
  }
  await repo.ensureLineParticipant(conversationId, citizenid, phoneId);
  return { ...created, id: conversationId } as ConversationRow;
};

/**
 * Bespoke queries for conversations. The schema and both allowlists come from the
 * declaration in `services/Conversations.ts` via `defineService`.
 *
 * Most of the methods below read or join `mica_messages_participants`, which is why
 * this class exists: membership lives in a join table that the generic single-table
 * path cannot reach. The join table's DDL is declared as a child table on the
 * conversations app so the generated schema stays complete.
 */
export class ConversationRepository extends SchemaRepository<ConversationRow> {
  async createConversation(data: Partial<ConversationRow>): Promise<number> {
    return await this.create(data as ConversationRow);
  }

  /**
   * Rename a thread, as its admin, through the phone the admin's membership is on (MICA-339).
   *
   * **Who may rename: the thread's admin, on the phone in their hand.** That is the creator's
   * membership — `create` writes it as `admin` — and it moves with the phone on a handover
   * (`transferParticipants`), where the row's own `citizenid` never did. The generic owner-scoped
   * update this replaces asked `citizenid = ?` of the conversation row, so the creator could still
   * rename a thread after selling the phone it was on and leaving it, and the phone's new holder
   * could not. A member who is not the admin is refused, as they always were.
   *
   * One statement, the membership predicate in its `WHERE`, so there is no window between asking
   * and writing. Named and on the repository because it writes without the row's own ownership
   * predicate (§2.9); the `EXISTS` is the authorization, with the citizen **and** the phone in
   * it, never the phone alone. `false` for a thread the caller is not the admin of, a deleted
   * one, and a name that did not change, which is what the generic update answered too.
   *
   * **Why not `updateUnscoped`**, which §2.9 names as the door for a privileged write. It
   * builds `UPDATE … WHERE id = ?` and takes no further predicate, so the admin check would
   * have to be a read before it: an `isMember`-style query, then the write. Between the two
   * the phone can change hands or the admin can leave, and the rename would land for someone
   * who no longer holds it. Keeping the check in the write's own `WHERE` is the stronger
   * guarantee, and widening `updateUnscoped` to carry one is a change to every repository's
   * core (`lib/Repository.ts`), not this one's. What `applyUpdate` would add is covered here:
   * the column is a literal (no payload key reaches the SQL), `assertWritableValue` applies the
   * column's own rule, and `name` is not an encrypted column, so there is nothing to seal.
   */
  async renameAsAdmin(
    conversationId: number,
    name: string,
    citizenid: string,
    phoneId: string
  ): Promise<boolean> {
    if (!citizenid || !phoneId) return false;
    this.assertWritableValue('name', name);
    return await Database.update(
      `UPDATE mica_messages_conversations c
          SET c.name = ?
        WHERE c.id = ? AND c.status = 'active'
          AND EXISTS (
              SELECT 1 FROM mica_messages_participants p
               WHERE p.conversation_id = c.id
                 AND p.citizenid = ? AND p.phone_id = ?
                 AND p.role = 'admin' AND p.status = 'active' AND p.left_at IS NULL
          )`,
      [name, conversationId, citizenid, phoneId]
    );
  }

  /**
   * `isParticipant` used to live here. It is now the inherited `Repository.isMember`,
   * derived from this service's `membership` declaration — same query, one definition, and
   * Messages no longer reaches into this class to authorize its own reads.
   */

  /**
   * Soft-delete a conversation for everyone in it.
   *
   * Privileged: the caller must have already confirmed the actor is an admin
   * participant. Named method rather than a raw unscoped update, because the
   * actor is not necessarily the row's `citizenid`.
   */
  async markDeletedByAdmin(conversationId: number): Promise<boolean> {
    return await this.updateUnscoped(conversationId, { status: 'deleted' });
  }

  /**
   * Put someone in a thread, unless they are already in it.
   *
   * The guarantee itself is the database's: `conversation_participant_unique` makes one
   * row per person per thread a constraint rather than a convention, so nothing — a
   * concurrent request included — can write a second one. This statement is what keeps
   * that constraint from surfacing as an error. A plain `INSERT` racing another would
   * raise a duplicate-key failure, which reaches a player as a failed action for what is
   * really a no-op; `NOT EXISTS` makes "already in the thread" the quiet outcome it
   * should be, and the index stays underneath as the thing that is actually load-bearing.
   *
   * It is one statement, so the check and the write cannot be prised apart the way a
   * `SELECT` followed by an `INSERT` in the service could be. The subquery is wrapped in a
   * derived table because MySQL otherwise refuses to re-read the table it is inserting
   * into (ER 1093); the wrapper forces it to materialise first.
   *
   * Without any of this, `participants: ["555-victim" x 500]` wrote 500 live rows for one
   * person, and `Messages.deliverToParticipants` then emitted 500 packets per message for
   * the life of the thread (MICA-153).
   *
   * `left_at IS NULL` is in the guard rather than the key because it is the liveness rule
   * every other query here uses; the key is the pair, which is stricter and is what the
   * table can actually enforce.
   *
   * Returns whether a row was actually written, so a caller can tell "added" from
   * "already in the thread".
   */
  async addParticipant(
    conversationId: number,
    citizenid: string,
    /** The phone the membership is on (MICA-282): the thread lives on the device. */
    phoneId: string,
    role: 'admin' | 'member' = 'member'
  ): Promise<boolean> {
    const query = `
            INSERT INTO mica_messages_participants
                (conversation_id, citizenid, phone_id, role, left_at, status)
            SELECT ?, ?, ?, ?, NULL, 'active' FROM DUAL
            WHERE NOT EXISTS (
                SELECT 1 FROM (
                    SELECT 1 FROM mica_messages_participants
                    WHERE conversation_id = ? AND phone_id = ? AND left_at IS NULL
                    LIMIT 1
                ) live
            )
        `;
    const insertId = await Database.insert(query, [
      conversationId,
      citizenid,
      phoneId,
      role,
      conversationId,
      phoneId
    ]);
    // A conditional insert that matched nothing reports an insert id of 0.
    return Boolean(insertId);
  }

  /**
   * The phone's live membership of a thread with a line, restored if it had left (MICA-275).
   *
   * Not `addParticipant` alone: `conversation_phone_unique` is on `(conversation_id,
   * phone_id)` and holds a left row too, so inserting a second row for a phone that left is
   * a duplicate-key error rather than a rejoin. A `left` row is reopened and re-pointed at
   * the phone's current holder; a phone with no row at all gets one; a live row is left
   * alone. `removed` and `moderated` are never reopened.
   *
   * Reached only from `openLineThread`, after `findExternalThread` matched this phone as one
   * side of the thread's pair columns, so it can only ever restore the phone the thread is
   * with. Named and privileged for the reason `transferParticipants` is: the row's citizenid
   * may be exactly what changes.
   */
  async ensureLineParticipant(
    conversationId: number,
    citizenid: string,
    phoneId: string
  ): Promise<void> {
    const restored = await Database.update(
      `UPDATE mica_messages_participants
          SET left_at = NULL, status = 'active', citizenid = ?
        WHERE conversation_id = ? AND phone_id = ? AND status = 'left' AND left_at IS NOT NULL`,
      [citizenid, conversationId, phoneId]
    );
    if (restored) return;
    await this.addParticipant(conversationId, citizenid, phoneId, 'member');
  }

  async removeParticipant(
    conversationId: number,
    citizenid: string,
    phoneId: string,
    status: string = 'removed'
  ) {
    // Find existing active session (left_at IS NULL) and close it
    // Status: 1=Active, -1=Moderated, 0=Left, 2=Removed
    const query = `
            UPDATE mica_messages_participants
            SET left_at = CURRENT_TIMESTAMP, status = ?
            WHERE conversation_id = ? AND citizenid = ? AND phone_id = ? AND left_at IS NULL
        `;
    return await Database.update(query, [status, conversationId, citizenid, phoneId]);
  }

  /**
   * A phone changed hands: every membership on it now names its new holder (MICA-282).
   *
   * The child-table twin of `Repository.transferPhoneRows`, reached through the handover hook
   * `Conversations.ts` registers because this table has no repository for the automatic walk
   * to find. `updated_at` is pinned so a handover does not reorder anyone's inbox. Named and
   * privileged for the same reason `markDeletedByAdmin` is: the row's citizenid is exactly
   * what is being changed, so no ownership predicate could express it.
   */
  async transferParticipants(phoneId: string, citizenid: string): Promise<boolean> {
    return await Database.update(
      `UPDATE mica_messages_participants
          SET citizenid = ?, updated_at = updated_at
        WHERE phone_id = ? AND citizenid <> ?`,
      [citizenid, phoneId, citizenid]
    );
  }

  /** A thread's live members, each with the number on its phone (`PARTICIPANT_NUMBER`). */
  async findParticipants(conversationId: number): Promise<ParticipantRow[]> {
    const query = `
            SELECT p.*, ${PARTICIPANT_NUMBER}
            FROM mica_messages_participants p
            WHERE p.conversation_id = ? AND p.left_at IS NULL
        `;
    return await Database.query<ParticipantRow[]>(query, [conversationId]);
  }

  /**
   * Move this participant's read cursor to now.
   *
   * Scoped by citizenid and `left_at IS NULL`, so a player can only ever mark
   * their own membership read, and only while they are still in the thread.
   */
  async markRead(conversationId: number, citizenid: string, phoneId: string): Promise<boolean> {
    const query = `
            UPDATE mica_messages_participants
            SET last_read = CURRENT_TIMESTAMP
            WHERE conversation_id = ? AND citizenid = ? AND phone_id = ? AND left_at IS NULL
        `;
    return await Database.update(query, [conversationId, citizenid, phoneId]);
  }

  /**
   * Archive or unarchive a thread for one participant.
   *
   * `left_at IS NULL` keeps a player who has left the thread from mutating a row they
   * no longer own a view of. No separate membership check is needed: a non-participant
   * matches no row and the update reports false.
   */
  async setArchived(
    conversationId: number,
    citizenid: string,
    phoneId: string,
    archived: boolean
  ): Promise<boolean> {
    const query = `
            UPDATE mica_messages_participants
            SET archived_at = ${archived ? 'CURRENT_TIMESTAMP' : 'NULL'}
            WHERE conversation_id = ? AND citizenid = ? AND phone_id = ? AND left_at IS NULL
        `;
    return await Database.update(query, [conversationId, citizenid, phoneId]);
  }

  /**
   * Every live participant of every conversation named, in **one** query.
   *
   * This replaces a per-conversation query in `Conversations.get` that was 1+N in the size of
   * a player's own thread list — and that hard-coded `LEFT JOIN players`, a table es_extended
   * does not have, so the whole Messages list threw on ESX (MICA-197).
   *
   * **No join onto the framework's character table, deliberately.** Putting the name here
   * looks obviously right and is not: micaOS pins every column to `utf8mb4_unicode_ci` and
   * es_extended's `users.identifier` takes the server default, which from MariaDB 11.4 is
   * `utf8mb4_uca1400_ai_ci` — and a column-to-column comparison across two collations is
   * MySQL errno 1267 rather than a slow query. `FrameworkBridge`'s own note above
   * `findOfflineByCitizenIds` has the whole finding. So this returns the membership and
   * `Conversations.get` asks `PlayerDirectory` for the names, whose lookups compare against
   * bound parameters and are collation-coercible.
   *
   * `conversation_id` values are bound parameters; the only interpolation is the placeholder
   * list (§2.9). Ids are deduplicated first, so a caller cannot turn a list of repeats into a
   * wider `IN`.
   */
  async findParticipantsForConversations(
    conversationIds: readonly number[]
  ): Promise<ParticipantRow[]> {
    const ids = [...new Set(conversationIds)].filter((id) => Number.isInteger(id));
    if (ids.length === 0) return [];

    const placeholders = ids.map(() => '?').join(', ');
    const query = `
            SELECT p.*, ${PARTICIPANT_NUMBER}
            FROM \`mica_messages_participants\` p
            WHERE p.\`conversation_id\` IN (${placeholders}) AND p.\`left_at\` IS NULL
        `;
    return await Database.query<ParticipantRow[]>(query, ids);
  }

  /**
   * A page of the caller's own threads, **most recently messaged first**.
   *
   * **Bounded, where it never used to be.** There was no `LIMIT` at all, and every row
   * carried two correlated subqueries — so the cost of opening Messages grew with the number
   * of threads a player had ever been in, forever. Keyset rather than an offset, matching
   * every other paged read in this repo: a conversation created while somebody is paging
   * shifts an offset and would make them see a row twice or not at all.
   *
   * **The keyset is compound, and that is MICA-211.** It used to be `c.id DESC`, which is a
   * different order from the one the inbox is displayed in — an old thread somebody texts
   * daily has a low id and a recent last message, so a page walked by id left it for a later
   * page while quieter, newer threads came first. That was survivable only because the page
   * was pinned at 200, above any real list, which is exactly the bound this removes. The sort
   * key is `COALESCE(m.created_at, c.updated_at)` — the last message's time, falling back to
   * the row's own for a thread nobody has written in yet, which is the same expression
   * `web/src/services/conversations.ts` derives `lastMessageAt` from, so the server's paging
   * order and the client's display order are the same order rather than two that agree by
   * luck. `c.id DESC` is the tiebreak: two threads can share a timestamp to the second, and
   * without it the boundary between one page and the next is not a position.
   *
   * **What it costs.** Ordering by an expression over a joined row cannot ride an index, so
   * this filesorts — over the caller's *own* threads, because the `me` join has already
   * narrowed the set to their membership before the sort. That is bounded by how many threads
   * one player is in, not by the table, which is why this stays preferable to denormalising a
   * `last_message_at` column onto the conversations table: that column would need maintaining
   * on every send and a backfill on every existing install, to buy an index on a set that is
   * already small.
   *
   * **One row more than the page is asked for and dropped**, the way `ServiceEndpoint` does
   * it, so `nextCursor` is exact rather than a `COUNT` or an inference the client makes from a
   * short page.
   *
   * **`participant_count` is gone from the SQL and is not lost.** It was the second
   * correlated subquery, counting exactly the rows `findParticipantsForConversations` now
   * returns for the same page; `Conversations.get` derives it from those instead. Nothing in
   * `web/` reads it, but the shape is kept so nothing outside this repo has to care.
   *
   * `unread_count` stays a subquery — it needs `me.last_read`, which only this join has in
   * scope — but it is now evaluated for one page rather than for a whole history.
   */
  async findForPhone(
    citizenid: string,
    /** The phone whose inbox this is (MICA-282) — beside the citizen, never instead (§2.9). */
    phoneId: string,
    page: { limit: number; cursor: RecencyCursor | null }
  ): Promise<{ rows: ConversationListRow[]; nextCursor: RecencyCursor | null }> {
    const params: unknown[] = [citizenid, phoneId];

    /**
     * Written once and used three times — the projection, the cursor predicate and the sort —
     * because the three disagreeing is the whole failure mode: a page boundary tested against
     * one expression and drawn by another skips rows silently.
     */
    const sortKey = 'COALESCE(m.`created_at`, c.`updated_at`)';

    /**
     * Strictly past the last row the caller already holds, in the compound order: an earlier
     * timestamp, or the same timestamp and a lower id. `<`, never `<=`, on both halves.
     */
    const cursorClause =
      page.cursor === null ? '' : `AND (${sortKey} < ? OR (${sortKey} = ? AND c.\`id\` < ?))`;
    if (page.cursor !== null) params.push(page.cursor.time, page.cursor.time, page.cursor.id);
    // One more than the page, so "is there another" is answered by the read rather than guessed.
    params.push(page.limit + 1);

    // Joined rather than EXISTS-filtered so the caller's own participant row
    // (`me`) is in scope — `me.last_read` is what makes unread_count computable.
    const query = `
            SELECT c.*,
            (SELECT COUNT(*) FROM mica_messages unread
                WHERE unread.conversation_id = c.id
                AND unread.status != 'deleted'
                AND (unread.citizenid <> me.citizenid OR unread.external_sender IS NOT NULL)
                AND unread.created_at > me.last_read) as unread_count,
            m.message as last_message_text,
            m.created_at as last_message_time,
            m.citizenid as last_message_sender,
            m.external_sender as last_message_external,
            me.archived_at as archived_at
            FROM mica_messages_conversations c
            JOIN mica_messages_participants me
                ON me.conversation_id = c.id
                AND me.citizenid = ?
                AND me.phone_id = ?
                AND me.left_at IS NULL
            LEFT JOIN mica_messages m ON m.id = (
                SELECT id FROM mica_messages
                WHERE conversation_id = c.id AND status != 'deleted'
                ORDER BY created_at DESC LIMIT 1
            )
            WHERE c.status = 'active'
            ${cursorClause}
            ORDER BY ${sortKey} DESC, c.\`id\` DESC
            LIMIT ?
        `;
    const results = await Database.query<any[]>(query, params);

    const hasMore = results.length > page.limit;
    const kept = hasMore ? results.slice(0, page.limit) : results;

    // Map flat results to Conversation objects with nested last_message. The last message's
    // text is sealed at rest (MICA-165): opened here off the context the join already carries,
    // its sender's citizenid and this conversation's id.
    // Declared by `services/Messages.ts`, which every server that reads this has loaded; a
    // sealed value with no declaration to open it by reads as the padlock, never as ciphertext.
    const sealedMessage = encryptedColumn('mica_messages', 'message');
    const rows = kept.map((row) => {
      const raw = row.last_message_text;
      const text =
        typeof raw !== 'string' || !isSealed(raw)
          ? raw
          : sealedMessage
            ? openContent(
                contentContext(sealedMessage, {
                  citizenid: row.last_message_sender,
                  conversation_id: row.id
                }),
                raw,
                `last of conversation ${row.id}`
              )
            : UNREADABLE_CONTENT;
      return {
        ...row,
        last_message_text: text,
        last_message: text
          ? {
              message: text,
              created_at: row.last_message_time,
              citizenid: row.last_message_sender,
              // A text from a line (MICA-223) is owned by the recipient's row but was not
              // written by them; the inbox reads this before it draws a "sent" tick.
              external_sender: row.last_message_external ?? null
            }
          : undefined
      };
    });

    /**
     * The last kept row's own position, which is where the next page starts.
     *
     * A timestamp this cannot read ends the list rather than emitting a cursor the predicate
     * above would not match — see `toSqlDateTime`. `null` is also what a page shorter than the
     * limit answers, so the client is told the end rather than inferring it from a short page
     * and paying an empty request to find out.
     */
    const last = kept[kept.length - 1];
    const lastTime = last ? toSqlDateTime(last.last_message_time ?? last.updated_at) : null;
    const nextCursor =
      hasMore && last && lastTime !== null ? { time: lastTime, id: Number(last.id) } : null;

    return { rows, nextCursor };
  }

  /**
   * After creating a pair thread, settle which one survives if two were created at once.
   *
   * **Why this is not a `NOT EXISTS` guard on the insert, like `addParticipant`'s.** A
   * conversation only becomes *a pair* once both participant rows exist, and those are
   * written after the conversation row. At the moment of the `INSERT` there is nothing for a
   * subquery to look at: the pair the guard would test for is a fact that does not exist
   * yet. So the check has to run afterwards, when both racers' membership is visible to each
   * other, and repair rather than prevent.
   *
   * **The deterministic part is what makes it safe.** Both racers ask the same question —
   * which is the lowest active pair id for these two people — so both get the same answer no
   * matter who asks first. Whoever is not that id stands down. Without the total order, two
   * racers each seeing the other would each defer, and both threads would be discarded.
   *
   * **It narrows the window; on its own it does not close it.** If both re-checks run before
   * either has written its participant rows, both still see only themselves and both
   * survive. That residue needed a uniquely-indexed pair key on the conversations table —
   * `pair_key_unique`, generated-column support in `defineService`, and a decided story for
   * duplicates already on live servers, all landed in MICA-161. The service's `create`
   * catches the duplicate-key error that index now throws for a genuinely simultaneous
   * insert and resolves it by looking the winner up, so this method's own remaining job is
   * the case *that* insert-level check cannot see: two inserts landing far enough apart to
   * both succeed (different pair-key commit timing) while still racing to be the pair's
   * canonical thread. What this removes on its own is the wide window between the service's
   * `findOneToOne` and its `create`, which spans two round trips and is where two people
   * opening a chat at the same moment actually collide.
   *
   * **Never discards anything that holds a message.** The reconciliation is only ever run
   * against a thread this request just created, but a message can in principle be written
   * into it in between, and losing one to a tidy-up is a worse bug than the duplicate. The
   * count is the condition, not an assertion.
   *
   * Returns the conversation the caller should use — its own id, or the older one it just
   * stood down in favour of.
   */
  async reconcilePairDuplicate(
    conversationId: number,
    /** The two phones of the pair (MICA-282). */
    phone1: string,
    phone2: string
  ): Promise<number> {
    const canonical = await Database.scalar<number | null>(
      `
            SELECT c.id
            FROM mica_messages_conversations c
            WHERE c.is_group = 0 AND c.status = 'active'
            AND EXISTS (
                SELECT 1 FROM mica_messages_participants p1
                WHERE p1.conversation_id = c.id AND p1.phone_id = ? AND p1.left_at IS NULL
            )
            AND EXISTS (
                SELECT 1 FROM mica_messages_participants p2
                WHERE p2.conversation_id = c.id AND p2.phone_id = ? AND p2.left_at IS NULL
            )
            ORDER BY c.id ASC
            LIMIT 1
        `,
      [phone1, phone2]
    );

    // No answer means the pair is not readable as a pair — a participant write that has not
    // landed, or a query that failed. Keep what was created rather than guess.
    if (typeof canonical !== 'number' || canonical === conversationId) return conversationId;

    const messages = await Database.scalar<number>(
      `SELECT COUNT(*) FROM mica_messages WHERE conversation_id = ? AND status <> 'deleted'`,
      [conversationId]
    );
    if (Number(messages) > 0) return conversationId;

    await this.discardEmptyDuplicate(conversationId);
    return canonical;
  }

  /**
   * Soft-delete a thread this request created and then found to be a duplicate.
   *
   * A named method over `updateUnscoped` rather than a service-level bypass, per AGENTS.md
   * §2.9: the row does belong to the caller, but the predicate that matters here is "this is
   * the duplicate we just made", which is not an ownership question and is established by
   * `reconcilePairDuplicate` rather than by the caller.
   */
  private async discardEmptyDuplicate(conversationId: number): Promise<boolean> {
    return await this.updateUnscoped(conversationId, { status: 'deleted' });
  }

  /**
   * The live 1:1 thread between two **phones** (MICA-282), or null.
   *
   * Phones rather than people, so one person's two phones can each hold a thread with the
   * same contact — and so a stolen phone continues the thread it was in rather than starting
   * a second one beside it.
   */
  /**
   * The thread between a phone and a line that is not a player (MICA-223).
   *
   * `findOneToOne` asks for two participant rows and a line has none: the only member of
   * such a thread is the phone. So the pair columns are the key here, in either order --
   * `pair_key_unique` is what guarantees there is at most one of them.
   */
  async findExternalThread(phoneId: string, externalKey: string): Promise<ConversationRow | null> {
    const rows = await Database.query<ConversationRow[]>(
      `SELECT c.*
         FROM mica_messages_conversations c
        WHERE c.is_group = 0 AND c.status = 'active'
          AND ((c.participant_a = ? AND c.participant_b = ?)
            OR (c.participant_a = ? AND c.participant_b = ?))
        LIMIT 1`,
      [phoneId, externalKey, externalKey, phoneId]
    );
    return rows.length > 0 ? rows[0] : null;
  }

  /**
   * The line side of a thread, or null when the thread is not one with a line (MICA-275).
   *
   * A line's side of the pair carries the `ext:` prefix `Messages.lineKey` gives it, and a
   * phone id never does (bare hex), so the prefix alone says which side it is. Filtered on
   * `active` for the same reason `findExternalThread` is: a deleted thread is no longer the
   * line's thread.
   */
  async lineKeyOf(conversationId: number): Promise<string | null> {
    const rows = await Database.query<Pick<ConversationRow, 'participant_a' | 'participant_b'>[]>(
      `SELECT c.participant_a, c.participant_b
         FROM mica_messages_conversations c
        WHERE c.id = ? AND c.is_group = 0 AND c.status = 'active'
        LIMIT 1`,
      [conversationId]
    );
    const row = rows[0];
    if (!row) return null;
    for (const side of [row.participant_a, row.participant_b]) {
      if (typeof side === 'string' && side.startsWith(LINE_KEY_PREFIX)) return side;
    }
    return null;
  }

  /**
   * Every thread between a phone and the line `externalKey` names, newest activity first, at
   * most `limit` of them (MICA-307: a job line's shared inbox). One statement.
   *
   * **`participant_b` alone.** `openLineThread` is the only writer of a line thread and always
   * puts the line's key in `participant_b` and the phone in `participant_a`; `findExternalThread`
   * checks both orders only defensively. One column is what an index can serve — an `OR` over
   * both would not — and `participant_b_status` serves it, so this reads the line's own threads
   * rather than every active thread on the server. `pair_key_unique` cannot: `LEAST`/`GREATEST`
   * puts the key first or second depending on the phone id.
   *
   * The newest message per thread is a correlated subquery that reads one entry of
   * `conversation_status_created` backward, with no sort: ordered by `created_at` (with the
   * implicit `id` as the tiebreak) because an `id` order cannot ride that key and filesorts
   * every thread's messages. A thread nobody has written a live message in is not in the inbox,
   * and a deleted or moderated message is never the one shown to staff. The player's number
   * joins `mica_phone_numbers` on `phone_id_unique`. The text is opened off the row's own
   * citizenid and conversation (MICA-165), as `findByConversation` opens a page. Checked by
   * EXPLAIN against MariaDB 11 with 5,200 threads and 104,000 messages.
   */
  async findLineThreads(externalKey: string, limit: number): Promise<LineThreadRow[]> {
    const rows = await Database.query<LineThreadRow[]>(
      `SELECT m.conversation_id, n.number AS from_number,
              m.id, m.citizenid, m.message, m.external_sender, m.created_at
         FROM mica_messages_conversations c
         JOIN mica_messages m ON m.id = (
              SELECT x.id FROM mica_messages x
               WHERE x.conversation_id = c.id AND x.status = 'active'
               ORDER BY x.created_at DESC, x.id DESC LIMIT 1)
         LEFT JOIN \`${PHONE_NUMBERS_TABLE}\` n ON n.phone_id = c.participant_a
        WHERE c.participant_b = ? AND c.is_group = 0 AND c.status = 'active'
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT ?`,
      [externalKey, limit]
    );
    return openRows('mica_messages', rows);
  }

  /**
   * The player a line thread is with: its participant, preferring one still in it (MICA-307).
   * A player who left keeps their row, and `openLineThread` puts them back when the line
   * texts, which is what a reply to them does. Null for a thread with no participant at all.
   */
  async lineThreadPlayer(conversationId: number): Promise<string | null> {
    const row = await Database.single<{ citizenid: string } | null>(
      `SELECT p.citizenid FROM mica_messages_participants p
        WHERE p.conversation_id = ?
        ORDER BY (p.left_at IS NULL) DESC, p.id DESC
        LIMIT 1`,
      [conversationId]
    );
    return row?.citizenid ?? null;
  }

  async findOneToOne(phone1: string, phone2: string): Promise<ConversationRow | null> {
    const query = `
            SELECT c.*
            FROM mica_messages_conversations c
            WHERE c.is_group = 0 AND c.status = 'active'
            AND EXISTS (
                SELECT 1 FROM mica_messages_participants p1
                WHERE p1.conversation_id = c.id AND p1.phone_id = ? AND p1.left_at IS NULL
            )
            AND EXISTS (
                SELECT 1 FROM mica_messages_participants p2
                WHERE p2.conversation_id = c.id AND p2.phone_id = ? AND p2.left_at IS NULL
            )
            LIMIT 1
        `;
    const result = await Database.query<ConversationRow[]>(query, [phone1, phone2]);
    return result.length > 0 ? result[0] : null;
  }
}
