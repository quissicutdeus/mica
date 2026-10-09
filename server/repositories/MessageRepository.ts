// SPDX-FileCopyrightText: 2025 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { SchemaRepository } from '../lib/defineService';
import { Database } from '../lib/Database';
import { openRows } from '../lib/contentCipher';
import type { Message } from '@mica/shared/types';

/**
 * A message as the server holds it (MICA-339): the wire `Message` without the two answers worked
 * out per reader, and with the sender's `citizenid`, which never leaves. `sender_id` is present
 * on a row `findByConversation` read, where SQL works it out; see `messageForReader`.
 */
export type MessageRow = Omit<Message, 'mine' | 'sender_id'> & {
  citizenid: string;
  sender_id?: number | null;
};

/**
 * A message row as one member of its thread receives it (MICA-339).
 *
 * Built field by field, so the sender's `citizenid` — and anything added to the table later — is
 * not handed to every member by a spread. `mine` is the reader's own question, answered here: a
 * text from a line sits on the reader's row without being theirs. `senderId` is the sending
 * member's `Participant.id`, or null; a caller that has it from SQL passes the row's own.
 */
export const messageForReader = (
  row: MessageRow,
  readerCitizenId: string,
  senderId: number | null = row.sender_id == null ? null : Number(row.sender_id)
): Message => ({
  id: Number(row.id),
  conversation_id: Number(row.conversation_id),
  mine: !row.external_sender && row.citizenid === readerCitizenId,
  sender_id: row.external_sender ? null : senderId,
  status: row.status,
  message: row.message,
  created_at: row.created_at,
  updated_at: row.updated_at,
  ...(row.edited === undefined ? {} : { edited: Boolean(row.edited) }),
  reply_to_id: row.reply_to_id ?? null,
  ...(row.external_sender ? { external_sender: row.external_sender } : {}),
  ...(row.attachments === undefined ? {} : { attachments: row.attachments })
});

/** A line thread's message as `findLinePage` reads it (MICA-307). */
export interface LineMessageRow {
  id: number;
  conversation_id: number;
  citizenid: string;
  message: string;
  external_sender: string | null;
  created_at: unknown;
  /** MySQL answers `EXISTS` with 1 or 0. */
  has_attachments: number | boolean;
}

/**
 * Bespoke queries for the messages table. The schema, the `columns` allowlist and
 * the empty `clientWritable` set all come from the declaration in `services/Messages.ts`
 * via `SchemaRepository`; this class only adds the multi-table reads and writes the
 * generic path cannot express.
 */
export class MessageRepository extends SchemaRepository<MessageRow> {
  async create(data: Partial<MessageRow>): Promise<number> {
    // 1. Insert Message
    const messageId = await super.create({
      conversation_id: data.conversation_id,
      citizenid: data.citizenid,
      message: data.message,
      reply_to_id: data.reply_to_id ?? null,
      external_sender: data.external_sender ?? null
    });

    // 2. Insert Attachments if any
    if (data.attachments && data.attachments.length > 0) {
      for (const attachment of data.attachments) {
        if (attachment.photo_id) {
          await Database.insert(
            'INSERT INTO mica_messages_attachments (message_id, citizenid, photo_id) VALUES (?, ?, ?)',
            [messageId, data.citizenid, attachment.photo_id]
          );
        }
      }
    }

    // 3. Update Conversation updated_at
    await Database.query(
      'UPDATE mica_messages_conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [data.conversation_id]
    );

    return messageId;
  }

  /**
   * Whether a message row belongs to a conversation, by id alone — the caller has already
   * been confirmed a participant of that conversation, which is what makes the id safe to
   * act on (MICA-209). Status is not consulted: a reply to a message that was unsent
   * afterwards keeps its pointer, and the UI shows nothing for a target it cannot find.
   */
  async inConversation(messageId: number, conversationId: number): Promise<boolean> {
    const found = await Database.scalar<number | null>(
      'SELECT 1 FROM `mica_messages` WHERE `id` = ? AND `conversation_id` = ? LIMIT 1',
      [messageId, conversationId]
    );
    return found !== null && found !== undefined;
  }

  /**
   * The newest live row of a thread before `messageId`, by who wrote it, or null when there is
   * none (MICA-307). A job line's staff are notified only when a player's text is what makes a
   * thread wait on an answer, and this is the row that says whether it already was. Only
   * `external_sender` is read, never the sealed body. One read of `conversation_id_id`.
   */
  async newestLiveBefore(
    conversationId: number,
    messageId: number
  ): Promise<{ external_sender: string | null } | null> {
    return await Database.single<{ external_sender: string | null } | null>(
      `SELECT m.external_sender FROM mica_messages m
        WHERE m.conversation_id = ? AND m.status = 'active' AND m.id < ?
        ORDER BY m.id DESC
        LIMIT 1`,
      [conversationId, messageId]
    );
  }

  /**
   * One page of a line thread as its staff read it (MICA-307): newest first, live rows only,
   * and whether each carried an attachment rather than the attachment, which is the player's
   * own media. One statement on `conversation_id_id`, plus an `EXISTS` per row on the
   * attachments' `message_id` key — joined to the picture, so a message whose only attachments
   * were moderated does not claim to carry one (MICA-339). A picture its owner deleted from their
   * gallery still counts: the recipient received it.
   *
   * Keyset on `id DESC` with an exclusive cursor, exactly as `findByConversation` pages, and
   * selected by `conversation_id` first, so a cursor lifted from another thread reads nothing
   * across. Unlike it, `moderated` rows are left out as well as `deleted` ones: staff are
   * strangers to the thread, and an admin hid that text. The caller has already proved the
   * thread is the line's.
   */
  async findLinePage(
    conversationId: number,
    page: { limit: number; cursor: number | null }
  ): Promise<{ rows: LineMessageRow[]; nextCursor: number | null }> {
    const params: unknown[] = [conversationId];
    if (page.cursor !== null) params.push(page.cursor);
    params.push(page.limit + 1);
    const fetched = openRows(
      'mica_messages',
      await Database.query<LineMessageRow[]>(
        `SELECT m.id, m.conversation_id, m.citizenid, m.message, m.external_sender, m.created_at,
                EXISTS (SELECT 1 FROM mica_messages_attachments a
                          JOIN mica_media p ON p.id = a.photo_id AND p.status <> 'moderated'
                         WHERE a.message_id = m.id)
                  AS has_attachments
           FROM mica_messages m
          WHERE m.conversation_id = ? AND m.status = 'active'
            ${page.cursor === null ? '' : 'AND m.id < ?'}
          ORDER BY m.id DESC
          LIMIT ?`,
        params
      )
    );
    const hasMore = fetched.length > page.limit;
    const rows = hasMore ? fetched.slice(0, page.limit) : fetched;
    const oldest = rows[rows.length - 1];
    return { rows, nextCursor: hasMore && oldest ? oldest.id : null };
  }

  /**
   * One page of a thread, newest first, handed back in reading order (MICA-212).
   *
   * Keyset on `id DESC`: the cursor is the lowest id the caller already holds and is
   * exclusive (`m.id < ?`), so the next page starts strictly below it and an insert at the
   * head of the thread shifts nothing — the reason paging here is a cursor and not an
   * offset. One row more than the page is asked for, and its existence is the answer to
   * "is there more", exactly as `ServiceEndpoint`'s generic paged read does it; the extra
   * row is dropped rather than returned.
   *
   * The page is selected by `conversation_id` **first**. A cursor is a row id off a payload
   * and therefore attacker-controlled (§2.9); one lifted from another thread only bounds this
   * thread's ids, and can read nothing across. Membership is the caller's to check before
   * this is reached.
   *
   * Rows come back oldest-first within the page — the order a thread renders in and the
   * order the client prepends in — rather than the `DESC` the keyset walks. `nextCursor` is
   * explicit, so nobody downstream needs the last row's id to know where the next page
   * starts, and nobody has to remember which end of the page is the old one.
   */
  async findByConversation(
    conversationId: number,
    page: { limit: number; cursor: number | null } = { limit: 50, cursor: null }
  ): Promise<{ rows: MessageRow[]; nextCursor: number | null }> {
    /**
     * Messages, plus the one derived column the thread cannot render without.
     *
     * `edited` is `updated_at > created_at`, computed by MySQL rather than by comparing two
     * timestamps in TypeScript. Not a style preference: the driver hands these back as a
     * `Date` on one column type and a `'YYYY-MM-DD HH:MM:SS'` string on another, and a
     * comparison that has to guess which is a comparison that is wrong on somebody's
     * server. Doing it in the statement means one definition of "this was edited", in the
     * same clock the write used.
     *
     * It is derived rather than stored because `mica_messages.updated_at` already carries
     * `ON UPDATE CURRENT_TIMESTAMP` — the trace falls out of the edit itself, so there is no
     * column to add, no migration, and no way for the flag and the row to disagree.
     *
     * A `deleted` message is filtered out for **every** participant, not just its sender:
     * unsending is a withdrawal from the conversation, and the soft delete is what keeps the
     * row available to moderation afterwards.
     */
    const cursorClause = page.cursor === null ? '' : 'AND m.id < ?';
    const params: unknown[] = [conversationId];
    if (page.cursor !== null) params.push(page.cursor);
    params.push(page.limit + 1);

    /**
     * Opened here, off each row's own citizenid and conversation (MICA-165): `m.*` is the
     * context, so nothing else needs selecting.
     *
     * `sender_id` is the sending member's membership id in this thread (MICA-339), which is
     * what a reader is told in place of the sender's citizenid. A correlated read per row on
     * `conversation_status`, over one page, so the thread stays three statements. Null for a
     * text from a line — its row sits under the recipient's citizenid — and for a sender who
     * has left; `senderIdOf` in `ConversationRepository` answers the same question in memory.
     */
    const fetched = openRows(
      'mica_messages',
      await Database.query<MessageRow[]>(
        `SELECT m.*, (m.updated_at > m.created_at) AS edited,
                CASE WHEN m.external_sender IS NULL THEN (
                  SELECT MIN(p.id) FROM mica_messages_participants p
                   WHERE p.conversation_id = m.conversation_id
                     AND p.citizenid = m.citizenid AND p.left_at IS NULL
                ) END AS sender_id
           FROM mica_messages m
          WHERE m.conversation_id = ? AND m.status != 'deleted'
            ${cursorClause}
          ORDER BY m.id DESC
          LIMIT ?`,
        params
      )
    );

    const hasMore = fetched.length > page.limit;
    const newestFirst = hasMore ? fetched.slice(0, page.limit) : fetched;
    const oldest = newestFirst[newestFirst.length - 1];
    const nextCursor = hasMore && typeof oldest?.id === 'number' ? oldest.id : null;
    const messages = [...newestFirst].reverse();

    if (messages.length === 0) return { rows: [], nextCursor: null };

    /**
     * Attachments, joined to `mica_media`.
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
     *
     * **Not a moderated picture** (MICA-339): the join drops a media row an admin moderated
     * after it was sent, so it stops showing in every thread it was attached to. Only
     * `moderated`, not "anything but `active`": a sender deleting the photo from their own
     * gallery (`deleted`) must not reach into every recipient's thread and take back what they
     * already received. Media's statuses are `active`, `deleted` and `moderated`.
     */
    // This page's attachments and nothing more: bound to the ids just selected rather than
    // to the conversation, or every page would re-hydrate the whole thread's pictures and
    // the cost the cursor bounds above would come straight back here.
    const messageIds = messages.map((msg) => msg.id);
    const placeholders = messageIds.map(() => '?').join(', ');
    const attachments = await Database.query<any[]>(
      `SELECT a.id, a.message_id,
              p.id AS media_id, p.kind, p.data, p.url, p.thumbnail,
              p.mime_type, p.duration_ms, p.alt_text
         FROM mica_messages_attachments a
         JOIN mica_media p ON a.photo_id = p.id AND p.status <> 'moderated'
        WHERE a.message_id IN (${placeholders})`,
      messageIds
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
      // MySQL answers a boolean expression with 1 or 0, which crosses NUI as a number and
      // would make `edited === true` false everywhere it is checked.
      msg.edited = Boolean(msg.edited);
    }

    return { rows: messages, nextCursor };
  }
}
