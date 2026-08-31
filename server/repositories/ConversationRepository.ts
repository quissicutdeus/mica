import { SchemaRepository } from '../lib/defineService';
import { Conversation, Participant } from '@shared/types';
import { Database } from '../lib/Database';

/**
 * Bespoke queries for conversations. The schema and both allowlists come from the
 * declaration in `services/Conversations.ts` via `defineService`.
 *
 * Nine of the methods below read or join `gphone_messages_participants`, which is why
 * this class exists: membership lives in a join table that the generic single-table
 * path cannot reach. The join table's DDL is declared as a child table on the
 * conversations app so the generated schema stays complete.
 */
export class ConversationRepository extends SchemaRepository<Conversation> {
  async createConversation(data: Partial<Conversation>): Promise<number> {
    return await this.create(data as Conversation);
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
    role: 'admin' | 'member' = 'member'
  ): Promise<boolean> {
    const query = `
            INSERT INTO gphone_messages_participants
                (conversation_id, citizenid, role, left_at, status)
            SELECT ?, ?, ?, NULL, 'active' FROM DUAL
            WHERE NOT EXISTS (
                SELECT 1 FROM (
                    SELECT 1 FROM gphone_messages_participants
                    WHERE conversation_id = ? AND citizenid = ? AND left_at IS NULL
                    LIMIT 1
                ) live
            )
        `;
    const insertId = await Database.insert(query, [
      conversationId,
      citizenid,
      role,
      conversationId,
      citizenid
    ]);
    // A conditional insert that matched nothing reports an insert id of 0.
    return Boolean(insertId);
  }

  async removeParticipant(conversationId: number, citizenid: string, status: string = 'removed') {
    // Find existing active session (left_at IS NULL) and close it
    // Status: 1=Active, -1=Moderated, 0=Left, 2=Removed
    const query = `
            UPDATE gphone_messages_participants 
            SET left_at = CURRENT_TIMESTAMP, status = ? 
            WHERE conversation_id = ? AND citizenid = ? AND left_at IS NULL
        `;
    return await Database.update(query, [status, conversationId, citizenid]);
  }

  async findParticipants(conversationId: number): Promise<Participant[]> {
    // Simply find those with left_at IS NULL
    const query = `
            SELECT * FROM gphone_messages_participants 
            WHERE conversation_id = ? AND left_at IS NULL
        `;
    const participants = await Database.query<Participant[]>(query, [conversationId]);
    return participants;
  }

  /**
   * Move this participant's read cursor to now.
   *
   * Scoped by citizenid and `left_at IS NULL`, so a player can only ever mark
   * their own membership read, and only while they are still in the thread.
   */
  async markRead(conversationId: number, citizenid: string): Promise<boolean> {
    const query = `
            UPDATE gphone_messages_participants
            SET last_read = CURRENT_TIMESTAMP
            WHERE conversation_id = ? AND citizenid = ? AND left_at IS NULL
        `;
    return await Database.update(query, [conversationId, citizenid]);
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
    archived: boolean
  ): Promise<boolean> {
    const query = `
            UPDATE gphone_messages_participants
            SET archived_at = ${archived ? 'CURRENT_TIMESTAMP' : 'NULL'}
            WHERE conversation_id = ? AND citizenid = ? AND left_at IS NULL
        `;
    return await Database.update(query, [conversationId, citizenid]);
  }

  async findForCitizen(citizenid: string): Promise<Conversation[]> {
    // Joined rather than EXISTS-filtered so the caller's own participant row
    // (`me`) is in scope — `me.last_read` is what makes unread_count computable.
    const query = `
            SELECT c.*,
            (SELECT COUNT(*) FROM gphone_messages_participants WHERE conversation_id = c.id AND left_at IS NULL) as participant_count,
            (SELECT COUNT(*) FROM gphone_messages unread
                WHERE unread.conversation_id = c.id
                AND unread.status != 'deleted'
                AND unread.citizenid <> me.citizenid
                AND unread.created_at > me.last_read) as unread_count,
            m.message as last_message_text,
            m.created_at as last_message_time,
            m.citizenid as last_message_sender,
            me.archived_at as archived_at
            FROM gphone_messages_conversations c
            JOIN gphone_messages_participants me
                ON me.conversation_id = c.id
                AND me.citizenid = ?
                AND me.left_at IS NULL
            LEFT JOIN gphone_messages m ON m.id = (
                SELECT id FROM gphone_messages
                WHERE conversation_id = c.id AND status != 'deleted'
                ORDER BY created_at DESC LIMIT 1
            )
            WHERE c.status = 'active'
            ORDER BY c.updated_at DESC
        `;
    const results = await Database.query<any[]>(query, [citizenid]);

    // Map flat results to Conversation objects with nested last_message
    return results.map((row) => ({
      ...row,
      last_message: row.last_message_text
        ? {
            message: row.last_message_text,
            created_at: row.last_message_time,
            citizenid: row.last_message_sender
          }
        : undefined
    }));
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
    citizenid1: string,
    citizenid2: string
  ): Promise<number> {
    const canonical = await Database.scalar<number | null>(
      `
            SELECT c.id
            FROM gphone_messages_conversations c
            WHERE c.is_group = 0 AND c.status = 'active'
            AND EXISTS (
                SELECT 1 FROM gphone_messages_participants p1
                WHERE p1.conversation_id = c.id AND p1.citizenid = ? AND p1.left_at IS NULL
            )
            AND EXISTS (
                SELECT 1 FROM gphone_messages_participants p2
                WHERE p2.conversation_id = c.id AND p2.citizenid = ? AND p2.left_at IS NULL
            )
            ORDER BY c.id ASC
            LIMIT 1
        `,
      [citizenid1, citizenid2]
    );

    // No answer means the pair is not readable as a pair — a participant write that has not
    // landed, or a query that failed. Keep what was created rather than guess.
    if (typeof canonical !== 'number' || canonical === conversationId) return conversationId;

    const messages = await Database.scalar<number>(
      `SELECT COUNT(*) FROM gphone_messages WHERE conversation_id = ? AND status <> 'deleted'`,
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

  async findOneToOne(citizenid1: string, citizenid2: string): Promise<Conversation | null> {
    // Find active 1-on-1 where both users are currently active participants
    const query = `
            SELECT c.*
            FROM gphone_messages_conversations c
            WHERE c.is_group = 0 AND c.status = 'active'
            AND EXISTS (
                SELECT 1 FROM gphone_messages_participants p1
                WHERE p1.conversation_id = c.id AND p1.citizenid = ? AND p1.left_at IS NULL
            )
            AND EXISTS (
                SELECT 1 FROM gphone_messages_participants p2
                WHERE p2.conversation_id = c.id AND p2.citizenid = ? AND p2.left_at IS NULL
            )
            LIMIT 1
        `;
    const result = await Database.query<Conversation[]>(query, [citizenid1, citizenid2]);
    return result.length > 0 ? result[0] : null;
  }
}
