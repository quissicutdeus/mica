import { SchemaRepository } from '../lib/defineService';
import { Database } from '../lib/Database';
import { Message } from '@shared/types';

/**
 * Bespoke queries for the messages table. The schema, the `columns` allowlist and
 * the empty `clientWritable` set all come from the declaration in `services/Messages.ts`
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

    /**
     * Attachments, joined to `gphone_media`.
     *
     * **The column list is explicit and `p.citizenid` is deliberately not in it.** A
     * conversation is shared, so anything selected here reaches every participant — and
     * the uploader's citizenid is the one field that would tie a picture back to a person
     * who only meant to send it. That is the same reasoning `publicColumns` encodes for a
     * public read (§10); `SELECT p.*` would have quietly handed it over.
     *
     * Enough columns to *draw* the thing, which is what `MediaThumb` needs: a video has no
     * `data` and renders from `thumbnail`, a GIF may be a `url`, and `duration_ms` is the
     * badge. Selecting only `data`, as this did, made every attachment a photo by
     * construction.
     */
    const attachments = await Database.query<any[]>(
      `SELECT a.id, a.message_id,
              p.id AS media_id, p.kind, p.data, p.url, p.thumbnail,
              p.mime_type, p.duration_ms, p.alt_text
         FROM gphone_messages_attachments a
         JOIN gphone_messages m ON a.message_id = m.id
         JOIN gphone_media p ON a.photo_id = p.id
        WHERE m.conversation_id = ?`,
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
      // `toString()` on the text columns for the same reason `Photos.ts` coerces them:
      // depending on driver and column type a `mediumtext` arrives as a Buffer, which
      // would cross NUI as `{type:'Buffer',data:[...]}` and render as nothing.
      list.push({
        id: att.id,
        media: {
          id: att.media_id,
          kind: att.kind ?? 'photo',
          data: att.data ? String(att.data) : undefined,
          url: att.url ?? undefined,
          thumbnail: att.thumbnail ? String(att.thumbnail) : undefined,
          mime_type: att.mime_type ?? undefined,
          duration_ms: att.duration_ms ?? undefined,
          alt_text: att.alt_text ?? undefined
        }
      });
    }

    for (const msg of messages) {
      msg.attachments = attachmentMap.get(msg.id) || [];
    }

    return messages;
  }
}
