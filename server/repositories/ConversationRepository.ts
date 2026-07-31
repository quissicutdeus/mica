import { Repository } from '../lib/Repository';
import { Conversation, Participant } from '@shared/types';
import { Database } from '../lib/Database';

export class ConversationRepository extends Repository<Conversation> {
  protected tableName = 'gphone_messages_conversations';

  protected columns = ['id', 'citizenid', 'is_group', 'name', 'status', 'created_at', 'updated_at'];

  // Renaming is the only generic write, and `update` scopes it to the creator.
  protected clientWritable = ['name'];

  async createConversation(data: Partial<Conversation>): Promise<number> {
    return await this.create(data as Conversation);
  }

  /**
   * Is this player currently in the conversation?
   *
   * The authorization primitive for everything conversation-scoped. Rows here are
   * shared between players, so ownership by `citizenid` is not the right question —
   * membership is.
   */
  async isParticipant(conversationId: number, citizenid: string): Promise<boolean> {
    const query = `
            SELECT 1 FROM gphone_messages_participants
            WHERE conversation_id = ? AND citizenid = ? AND left_at IS NULL
            LIMIT 1
        `;
    const result = await Database.single<unknown>(query, [conversationId, citizenid]);
    return Boolean(result);
  }

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

  async addParticipant(
    conversationId: number,
    citizenid: string,
    role: 'admin' | 'member' = 'member'
  ) {
    // Insert new session row
    return await Database.insert(
      "INSERT INTO gphone_messages_participants (conversation_id, citizenid, role, left_at, status) VALUES (?, ?, ?, NULL, 'active')",
      [conversationId, citizenid, role]
    );
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

  async findForCitizen(citizenid: string): Promise<Conversation[]> {
    // Find conversations where user has an active session
    const query = `
            SELECT c.*, 
            (SELECT COUNT(*) FROM gphone_messages_participants WHERE conversation_id = c.id AND left_at IS NULL) as participant_count,
            m.message as last_message_text,
            m.created_at as last_message_time,
            m.citizenid as last_message_sender
            FROM gphone_messages_conversations c
            LEFT JOIN gphone_messages m ON m.id = (
                SELECT id FROM gphone_messages 
                WHERE conversation_id = c.id AND status != 'deleted' 
                ORDER BY created_at DESC LIMIT 1
            )
            WHERE EXISTS (
                SELECT 1 FROM gphone_messages_participants p 
                WHERE p.conversation_id = c.id AND p.citizenid = ? AND p.left_at IS NULL
            ) AND c.status = 'active'
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
