import { MessageRepository } from '../repositories/MessageRepository';
import { conversations, type ConversationRepo } from './ConversationController';
// Photos is a declared app; reuse its derived repository rather than a second
// instance, so the attachment-ownership check runs against the same allowlist.
import { photos } from './PhotoController';
import { defineServerApp } from '../lib/defineServerApp';
import { conversationIdFrom, requirePositiveInt } from '../lib/payload';
import { Message } from '@shared/types';

/**
 * Messages: shared scope.
 *
 * `gphone_messages.citizenid` is the **sender**, not an owner, so ownership scoping
 * is the wrong authorization question — access is decided by conversation
 * membership. `scope: 'shared'` therefore registers no generic mutation events at
 * all; both actions below check membership explicitly.
 *
 * The attachments join table is declared as a child table so `pnpm generate:sql`
 * emits a complete schema. It carries neither `status` nor timestamps, which is why
 * it cannot use the primary-table shape.
 */
export const messages = defineServerApp<Message>({
  id: 'messages',
  table: 'gphone_messages',
  scope: 'shared',
  statuses: ['active', 'deleted', 'moderated'],
  schema: {
    conversation_id: {
      type: 'int',
      notNull: true,
      references: { table: 'gphone_messages_conversations', column: 'id' }
    },
    message: { type: 'text', notNull: true }
  },
  indexes: [
    { name: 'citizenid', columns: ['citizenid'] },
    { name: 'conversation_status_created', columns: ['conversation_id', 'status', 'created_at'] }
  ],
  childTables: [
    {
      name: 'gphone_messages_attachments',
      columns: {
        message_id: {
          type: 'int',
          notNull: true,
          references: { table: 'gphone_messages', column: 'id' }
        },
        citizenid: {
          type: 'string',
          length: 50,
          notNull: true,
          references: { table: 'players', column: 'citizenid' }
        },
        photo_id: {
          type: 'int',
          notNull: true,
          references: { table: 'gphone_photos', column: 'id' }
        }
      },
      indexes: [
        { name: 'message_id', columns: ['message_id'] },
        { name: 'citizenid', columns: ['citizenid'] },
        { name: 'photo_id', columns: ['photo_id'] }
      ]
    }
  ],
  options: { disableGet: true },
  repositoryFactory: (resolved) => new MessageRepository(resolved)
});

const app = messages.app;
const messageRepo = messages.repo as MessageRepository;
const conversationRepo = conversations.repo as ConversationRepo;
const photoRepo = photos.repo;

/**
 * Messages live in a table shared between players, so ownership by `citizenid` is
 * the wrong question — membership is. Without this check, a client can walk
 * conversation ids and read or write anyone's threads.
 */
const requireParticipant = async (conversationId: number, citizenid: string): Promise<void> => {
  const isParticipant = await conversationRepo.isParticipant(conversationId, citizenid);
  if (!isParticipant) {
    throw new Error('Not a participant in this conversation.');
  }
};

/**
 * Keep only the attachments whose photo the sender actually owns. A `photo_id` is
 * a client-supplied row id, so an unchecked one lets a player attach — and thereby
 * disclose — someone else's photo.
 */
const resolveOwnedAttachments = async (
  raw: unknown,
  citizenid: string
): Promise<{ photo_id: number }[]> => {
  if (!Array.isArray(raw)) return [];

  const owned: { photo_id: number }[] = [];
  for (const attachment of raw) {
    let photoId: number;
    try {
      photoId = requirePositiveInt(attachment?.photo_id, 'photo id');
    } catch {
      continue;
    }

    const photo = await photoRepo.findById(photoId, citizenid);
    if (photo) {
      owned.push({ photo_id: photoId });
    } else {
      console.warn(`[MessageController] Dropped attachment ${photoId} not owned by ${citizenid}.`);
    }
  }
  return owned;
};

app.registerEvent('get', async (source, cbId, data, citizenid) => {
  const conversationId = conversationIdFrom(data);
  await requireParticipant(conversationId, citizenid);

  return await messageRepo.findByConversation(conversationId);
});

app.registerEvent('send', async (source, cbId, data, citizenid) => {
  // data: { conversation_id, message, attachments? }
  const conversationId = conversationIdFrom(data);
  await requireParticipant(conversationId, citizenid);

  const message = typeof data?.message === 'string' ? data.message : '';
  const attachments = await resolveOwnedAttachments(data?.attachments, citizenid);
  if (!message.trim() && attachments.length === 0) {
    throw new Error('A message body or an attachment is required.');
  }

  const newMessage: Partial<Message> = {
    conversation_id: conversationId,
    citizenid: citizenid,
    message,
    attachments, // Array of { photo_id }
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    status: 'active'
  };

  const id = await messageRepo.create(newMessage);
  return { ...newMessage, id };
});
