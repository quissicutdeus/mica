import { MessageRepository } from '../repositories/MessageRepository';
import { ConversationRepository } from '../repositories/ConversationRepository';
import { PhotoRepository } from '../repositories/PhotoRepository';
import { ServerApp } from '../lib/ServerApp';
import { Message } from '@shared/types';

const messageRepo = new MessageRepository();
const conversationRepo = new ConversationRepository();
const photoRepo = new PhotoRepository();

const app = new ServerApp<Message>('messages', messageRepo, {
  disableGet: true,
  disableCreate: true,
  disableUpdate: true,
  disableDelete: true
});

/** Accepts `{ conversation_id }` or a bare id. */
const requireConversationId = (data: any): number => {
  const raw = data && typeof data === 'object' ? data.conversation_id : data;
  const conversationId = Number(raw);
  if (!Number.isInteger(conversationId) || conversationId <= 0) {
    throw new Error('A valid conversation_id is required.');
  }
  return conversationId;
};

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
    const photoId = Number(attachment?.photo_id);
    if (!Number.isInteger(photoId) || photoId <= 0) continue;

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
  const conversationId = requireConversationId(data);
  await requireParticipant(conversationId, citizenid);

  return await messageRepo.findByConversation(conversationId);
});

app.registerEvent('send', async (source, cbId, data, citizenid) => {
  // data: { conversation_id, message, attachments? }
  const conversationId = requireConversationId(data);
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
