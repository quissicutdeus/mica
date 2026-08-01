import { SchemaRepository } from '../lib/defineService';
import { Database } from '../lib/Database';
import { Message } from '@shared/types';

/**
 * Bespoke queries for the messages table. The schema, the `columns` allowlist and
 * the empty `clientWritable` set all come from the declaration in MessageController
 * via `SchemaRepository`; this class only adds the multi-table reads and writes the
 * generic path cannot express.
 */
export class MessageRepository extends SchemaRepository<Message> {
  async create(data: Partial<Message>): Promise<number> {
    // 1. Insert Message
    const messageId = await super.create({
      conversation_id: data.conversation_id,
      citizenid: data.citizenid,
      message: data.message
    });

    // 2. Insert Attachments if any
    if (data.attachments && data.attachments.length > 0) {
      for (const attachment of data.attachments) {
        if (attachment.photo_id) {
          await Database.insert(
            'INSERT INTO gphone_messages_attachments (message_id, citizenid, photo_id) VALUES (?, ?, ?)',
            [messageId, data.citizenid, attachment.photo_id]
          );
        }
      }
    }

    // 3. Update Conversation updated_at
    await Database.query(
      'UPDATE gphone_messages_conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [data.conversation_id]
    );

    return messageId;
  }

  async findByConversation(conversationId: number): Promise<Message[]> {
    // Fetch messages
    const messages = await Database.query<Message[]>(
      "SELECT * FROM gphone_messages WHERE conversation_id = ? AND status != 'deleted' ORDER BY created_at ASC",
      [conversationId]
    );

    if (messages.length === 0) return [];

    // Fetch attachments for these messages
    // Join to gphone_photos to retrieve the image data
    const attachments = await Database.query<any[]>(
      'SELECT a.id, a.message_id, p.image as attachment FROM gphone_messages_attachments a JOIN gphone_messages m ON a.message_id = m.id JOIN gphone_photos p ON a.photo_id = p.id WHERE m.conversation_id = ?',
      [conversationId]
    );

    // Map attachments to messages
    const attachmentMap = new Map<number, any[]>();
    for (const att of attachments) {
      let list = attachmentMap.get(att.message_id);
      if (!list) {
        list = [];
        attachmentMap.set(att.message_id, list);
      }
      list.push({ id: att.id, attachment: att.attachment.toString() });
    }

    for (const msg of messages) {
      msg.attachments = attachmentMap.get(msg.id) || [];
    }

    return messages;
  }
}
