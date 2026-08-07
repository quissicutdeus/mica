import { MessageRepository } from '../repositories/MessageRepository';
import { conversations, type ConversationRepo } from './Conversations';
// Photos is a declared app; reuse its derived repository rather than a second
// instance, so the attachment-ownership check runs against the same allowlist.
import { photos } from './Photos';
import { defineService } from '../lib/defineService';
import { conversationIdFrom, fields, requirePositiveInt } from '../lib/payload';
import { Message } from '@shared/types';
import { FrameworkBridge } from '../lib/FrameworkBridge';

/**
 * Messages: membership on both axes.
 *
 * `gphone_messages.citizenid` is the **sender**, not an owner, so ownership scoping is the
 * wrong authorization question — access is decided by conversation membership. Both axes
 * are therefore `members`, which registers no generic CRUD at all: a membership check needs
 * the parent conversation id, and that is not part of the generic payload contract. Both
 * actions below supply it and check first.
 *
 * Note `localKey: 'conversation_id'`. A conversation's membership is keyed on its own `id`;
 * a *message*'s is keyed on its parent's. Same join table, different local column — which
 * is exactly why `localKey` exists, and why this table was inexpressible before it did.
 *
 * The attachments join table is declared as a child table so `pnpm generate:sql`
 * emits a complete schema. It carries neither `status` nor timestamps, which is why
 * it cannot use the primary-table shape.
 */
export const messages = defineService<Message>({
  id: 'messages',
  reportable: { label: 'Message', previewColumn: 'message' },
  table: 'gphone_messages',
  access: {
    read: 'members',
    write: 'members',
    membership: {
      table: 'gphone_messages_participants',
      foreignKey: 'conversation_id',
      localKey: 'conversation_id',
      liveWhileNull: 'left_at'
    }
  },
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
          references: { table: 'gphone_media', column: 'id' }
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
 *
 * The predicate itself comes from this service's own `membership` declaration via the
 * inherited `isMember`, rather than from a second hand-written query in
 * `ConversationRepository`. Both used to exist and had to agree on what "still in the
 * thread" meant; now there is one definition and it is the declaration.
 */
const requireParticipant = async (conversationId: number, citizenid: string): Promise<void> => {
  if (!(await messageRepo.isMember(conversationId, citizenid))) {
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
      console.warn(`[messages] Dropped attachment ${photoId} not owned by ${citizenid}.`);
    }
  }
  return owned;
};

app.registerEvent('get', async (source, cbId, data, citizenid) => {
  const conversationId = conversationIdFrom(data);
  await requireParticipant(conversationId, citizenid);

  return await messageRepo.findByConversation(conversationId);
});

/**
 * Push a new message to everyone else in the thread.
 *
 * Sending used to write the row and tell nobody. The reply went back to the sender and
 * that was the end of it — the recipient's phone learned nothing, so a text only ever
 * appeared if they happened to re-open the conversation and it re-fetched. With apps
 * resident across an open/close cycle, often not even then.
 *
 * Offline participants are skipped rather than queued: the row is already written, so
 * they get it from the normal fetch when they next open the thread.
 */
export const deliverToParticipants = async (
  conversationId: number,
  senderCitizenId: string,
  sender: { name?: string | null; phone?: string | null },
  message: Message & { id: number }
): Promise<void> => {
  const participants = await conversationRepo.findParticipants(conversationId);

  for (const participant of participants) {
    if (participant.citizenid === senderCitizenId) continue;
    if (participant.status && participant.status !== 'active') continue;

    const target = FrameworkBridge.getSourceByCitizenId(participant.citizenid);
    // Offline. The row is written, so they get it from the normal fetch next time.
    if (!target) continue;

    // The shape the shell's `receiveMessage` route already expects: it appends to the
    // thread and raises a toast with an inline reply.
    emitNet('gphone:client:messages:received', target, {
      conversation_id: conversationId,
      message: message.message,
      senderName: sender.name ?? undefined,
      phone: sender.phone ?? undefined,
      row: message
    });
  }
};

app.registerEvent('send', async (source, cbId, data, citizenid) => {
  // data: { conversation_id, message, attachments? }
  const conversationId = conversationIdFrom(data);
  await requireParticipant(conversationId, citizenid);

  const body = fields(data);
  const message = typeof body.message === 'string' ? body.message : '';
  const attachments = await resolveOwnedAttachments(body.attachments, citizenid);
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
  const stored = { ...newMessage, id } as Message & { id: number };

  // Delivery must not fail the send: the row is committed either way, and the sender
  // should not see an error for something that already happened.
  try {
    const senderPlayer = FrameworkBridge.getPlayer(source);
    const charinfo = senderPlayer?.rawPlayer?.PlayerData?.charinfo;
    const name = charinfo ? `${charinfo.firstname ?? ''} ${charinfo.lastname ?? ''}`.trim() : '';
    await deliverToParticipants(
      conversationId,
      citizenid,
      { name: name || null, phone: senderPlayer?.phone ?? null },
      stored
    );
  } catch (error) {
    console.error('[Messages] Delivery failed for conversation', conversationId, error);
  }

  return stored;
});
