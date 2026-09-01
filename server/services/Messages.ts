// SPDX-FileCopyrightText: 2025 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { MessageRepository } from '../repositories/MessageRepository';
import { conversations, type ConversationRepo } from './Conversations';
// Media is a declared app; reuse its derived repository rather than a second
// instance, so the attachment-ownership check runs against the same allowlist.
import { media } from './Media';
import { defineService } from '../lib/defineService';
import { conversationIdFrom, fields, requirePositiveInt } from '../lib/payload';
import { resolveOwnedAttachments } from '../lib/attachments';
import { Message } from '@gphone/shared/types';
import { FrameworkBridge } from '../lib/FrameworkBridge';
import { AuditLogger } from '../lib/AuditLogger';
import { Database } from '../lib/Database';
import { isPlausibleEmoji } from '../lib/reactions';
import { isBlocked } from './Blocklist';

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
    },
    /**
     * MICA-143: reactions on a message, using the shared client-side primitive
     * (`createReactionStore`/`ReactionBar`, MICA-98) but **not** `gphone_account_reactions`
     * — see the docblock above `requireReactableMessage` below for why that table does not
     * fit here. Keyed on `citizenid` rather than an `account_id`, because a message's own
     * membership is already decided by citizenid (`requireParticipant`), and Messages has no
     * account layer to key on instead.
     */
    {
      name: 'gphone_messages_reactions',
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
        // Free text, matching `gphone_account_reactions.emoji`: the picker offers a fixed
        // palette plus a "+" for any other emoji, so the column has to accept anything the
        // palette does not enumerate.
        emoji: { type: 'string', length: 32, notNull: true },
        created_at: { type: 'timestamp', notNull: true, defaultNow: true }
      },
      indexes: [
        // One reaction per participant per emoji per message — tapping the same emoji
        // twice toggles it off rather than stacking a duplicate row, the same idempotency
        // shape `gphone_account_reactions` uses.
        {
          name: 'message_citizen_emoji',
          columns: ['message_id', 'citizenid', 'emoji'],
          unique: true
        },
        // The batched read's own lookup: every reaction on a page of messages, one query.
        { name: 'message_id', columns: ['message_id'] }
      ]
    }
  ],
  options: { disableGet: true },
  repositoryFactory: (resolved) => new MessageRepository(resolved)
});

const app = messages.app;
const messageRepo = messages.repo as MessageRepository;
const conversationRepo = conversations.repo as ConversationRepo;
const mediaRepo = media.repo;

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
 * The message a payload names, if the caller is allowed to change it — and a loud
 * refusal otherwise.
 *
 * **Two predicates, and neither one is sufficient alone.** `findById` with a citizenid puts
 * the ownership predicate in the WHERE, so a row id is never authorization on its own
 * (§2.9); here it happens to be the right first question, because
 * `gphone_messages.citizenid` is the **sender**, so "did you write this" genuinely is an
 * ownership question. Membership then asks what ownership cannot: are you still in the
 * thread this message is in. Someone who left a conversation may not keep reaching into it,
 * even for their own words.
 *
 * **The conversation id comes off the row, never off the payload.** A caller supplying their
 * own would be naming a thread they *are* in while acting on a message from one they are
 * not, and `requireParticipant` would happily pass on the wrong conversation. This is the
 * one place in the service where `conversationIdFrom` would be exactly the wrong helper.
 *
 * A row that is already `deleted` or `moderated` is refused rather than silently no-oped:
 * `Repository.update` excludes `moderated` anyway, and an unsend of an unsent message
 * would report success for a write that did nothing.
 */
const requireOwnMessage = async (data: unknown, citizenid: string): Promise<Message> => {
  const id = requirePositiveInt(fields(data).id ?? data, 'message id');
  const row = await messageRepo.findById(id, citizenid);
  if (!row) throw new Error('That message is not yours to change.');
  if ((row.status ?? 'active') !== 'active') {
    throw new Error('That message is no longer available.');
  }
  await requireParticipant(row.conversation_id, citizenid);
  return row;
};

app.registerEvent('get', async (source, cbId, data, citizenid) => {
  const conversationId = conversationIdFrom(data);
  await requireParticipant(conversationId, citizenid);

  return await messageRepo.findByConversation(conversationId);
});

/**
 * Fix a message you sent — and leave a mark saying you did.
 *
 * **An edit is visible, deliberately.** A delivered message has already been read; a
 * silent rewrite would let one participant change what the transcript says the other
 * agreed to, and the other party would have no way of telling. So the thread renders an
 * "Edited" marker beside any message whose `updated_at` has moved past its `created_at`.
 * `MessageRepository.findByConversation` derives that in SQL, which is why this needed no
 * new column: `gphone_messages.updated_at` already carries
 * `ON UPDATE CURRENT_TIMESTAMP`, so the trace is a consequence of the write rather than a
 * second field somebody has to remember to set.
 *
 * **No edit window here, and that is a decision rather than an omission.** The mechanism
 * this repo has is `access.editWindow`, which `defineService` refuses for anything but an
 * `'owner'` write — Messages writes as `'members'`, so the predicate it installs on
 * `Repository.update` is structurally unavailable. Hand-rolling a second recency check
 * beside it would mean two definitions of "too late to edit" in one codebase, and the
 * thing a window half-buys — the other party not being deceived — the marker buys
 * outright, permanently, rather than for fifteen minutes. Blabber freezes a *public* post
 * because strangers quote and react to it; a private thread's guarantee is that both
 * parties can see what changed.
 *
 * An empty body is refused rather than accepted: a message edited down to nothing is an
 * unsend, and that is the other action, with its own confirmation in front of it.
 */
app.registerEvent('edit', async (source, cbId, data, citizenid) => {
  const row = await requireOwnMessage(data, citizenid);

  const raw = fields(data).message;
  const message = typeof raw === 'string' ? raw.trim() : '';
  if (!message) {
    throw new Error('A message needs some text. Unsend it instead of emptying it.');
  }
  // The generic write path validates against `columnRules` inside `ServiceEndpoint`; a
  // custom action reaches the repository directly, so it asks for itself.
  messageRepo.assertWritableValue('message', message);

  /**
   * Saving the same text is not an edit.
   *
   * `Database.update` reports rows *changed*, so an identical value comes back as `false`
   * and would otherwise be reported to the player as a failure — and worse, an
   * `ON UPDATE CURRENT_TIMESTAMP` that never fired would leave the row honestly unedited
   * while the UI had just claimed otherwise. `edited` is left off the reply so the client
   * keeps whatever the row already said.
   */
  if (message === row.message) {
    return { id: row.id, conversation_id: row.conversation_id, message };
  }

  const success = await messageRepo.update(row.id, { message } as Partial<Message>, citizenid);
  if (!success) throw new Error('That message could not be edited.');

  return { id: row.id, conversation_id: row.conversation_id, message, edited: true };
});

/**
 * Take back a message you sent.
 *
 * **This is an unsend, not a hide-for-me, and the UI says so.** `Repository.delete` moves
 * `status` to `deleted` — soft, so moderation and the audit ledger keep the evidence a
 * report may later be about — but `findByConversation` filters `status != 'deleted'` for
 * *every* participant, so what a reader sees is the message gone from the thread. Hiding
 * it for the sender alone would need per-participant state this table does not have
 * (`gphone_messages_participants` carries membership, not per-message visibility), and
 * shipping the ambiguous version of a destructive action is worse than shipping neither.
 * The confirmation in the app names the consequence rather than leaving it to be guessed.
 *
 * There is no time limit, matching `Repository.delete`'s own `enforceEditWindow: false`:
 * withdrawing what you said stays possible forever, because a window is about rewriting.
 *
 * Audited for the same reason the generic delete is — a moderator looking at a report of a
 * message that is no longer in the thread needs to know it was the author who removed it.
 */
app.registerEvent('delete', async (source, cbId, data, citizenid) => {
  const row = await requireOwnMessage(data, citizenid);

  const success = await messageRepo.delete(row.id, citizenid);
  if (success) {
    await AuditLogger.log({
      citizenid,
      action: 'deleted',
      service: 'messages',
      method: 'delete',
      targetId: row.id,
      targetTable: 'gphone_messages'
    });
  }
  return success;
});

/**
 * MICA-143: reactions on Messages, reusing the shared client-side primitive
 * (`createReactionStore`/`ReactionBar`, MICA-98) with server-side storage of its own —
 * `gphone_messages_reactions` above, not `gphone_account_reactions`.
 *
 * **Why not the shared accounts table.** `gphone_account_reactions.account_id` is a
 * `NOT NULL` foreign key onto `gphone_accounts`, Blabber's identity graph, where one player
 * may hold several handles per app. Native Messages has no such layer at all — a message is
 * sent and read by the citizenid on the session, the same identity `requireParticipant`
 * already checks membership by. Two ways to reuse the shared table were considered and both
 * rejected: widening `account_id` to accept a citizenid instead (a retype of a column
 * Blabber's own reactions depend on, needing a migration and touching a table this ticket
 * was not about) and minting an implicit per-player "account" for a `messages` app (stretching
 * what an account *means* — a deliberately reclaimable, possibly-plural handle — onto a
 * system that is 1:1 with the character and has no handle at all). Either would also let
 * `gphone_messages`' numeric row ids collide with every other reactable table's ids inside
 * one shared column if `messages` were ever declared `reactable`, which is deliberately not
 * done: see the declaration above. A citizenid-keyed **child table** needed neither — it is
 * additive DDL only (`gphoneschema apply` picks it up the same way it does any new table,
 * no versioned migration), and it keys reactions on the identity Messages already uses.
 *
 * **Membership, not ownership — for `react`.** Any current participant may react to any
 * message in the thread, not just its sender, so this checks `requireParticipant` rather
 * than `requireOwnMessage`. Refused once the message is no longer `active`: reacting to a
 * message that has been unsent or moderated has nothing left to react to.
 *
 * **`unreact` needs neither.** The `DELETE` is scoped to the caller's own citizenid in the
 * `WHERE`, the same as `Accounts.ts`'s `unreact` (§2.9) — a citizenid can only ever remove
 * its own reaction row, which is safe regardless of whether they are still a participant.
 * Taking back your own reaction stays possible even after leaving the thread or the message
 * being deleted later, the same "withdrawing stays possible forever" reasoning `delete`
 * above documents for the message itself.
 *
 * **`reactionsFor` is scoped to conversations the caller currently belongs to**, unlike
 * Blabber's batched read of the same shape: a Blab is a public post, so nothing there needs
 * scoping, but a message lives in a private thread, and a batched read that trusted every id
 * in the payload (§2.9) would hand back reaction counts, and which emoji the caller used,
 * for a conversation it has no other way to see into.
 */
const requireReactableMessage = async (messageId: number, citizenid: string): Promise<Message> => {
  const row = await messageRepo.findById(messageId);
  if (!row) throw new Error('That message is not available.');
  await requireParticipant(row.conversation_id, citizenid);
  if ((row.status ?? 'active') !== 'active') {
    throw new Error('That message is no longer available.');
  }
  return row;
};

app.registerEvent('react', async (source, cbId, data, citizenid) => {
  const body = fields(data);
  const messageId = requirePositiveInt(body.message_id, 'message id');
  if (!isPlausibleEmoji(body.emoji)) throw new Error('That is not a single emoji.');

  await requireReactableMessage(messageId, citizenid);

  try {
    await Database.insert(
      `INSERT INTO \`gphone_messages_reactions\`
       (\`message_id\`, \`citizenid\`, \`emoji\`) VALUES (?, ?, ?)`,
      [messageId, citizenid, body.emoji]
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (!/duplicate/i.test(message)) throw error;
  }
  return true;
});

app.registerEvent('unreact', async (source, cbId, data, citizenid) => {
  const body = fields(data);
  const messageId = requirePositiveInt(body.message_id, 'message id');
  if (!isPlausibleEmoji(body.emoji)) throw new Error('That is not a single emoji.');

  await Database.update(
    `DELETE FROM \`gphone_messages_reactions\`
     WHERE \`message_id\` = ? AND \`citizenid\` = ? AND \`emoji\` = ?`,
    [messageId, citizenid, body.emoji]
  );
  return true;
});

/**
 * Grouped reaction counts for a page of messages, plus which of them the caller has already
 * used — mirrors `accounts:reactionsFor`'s batched shape, one call per page of messages
 * rather than one per row.
 */
app.registerEvent('reactionsFor', async (source, cbId, data, citizenid) => {
  const body = fields(data);
  const raw = Array.isArray(body.target_ids) ? body.target_ids : [];
  const requested = raw
    .map((value) => {
      try {
        return requirePositiveInt(value, 'message id');
      } catch {
        return null;
      }
    })
    .filter((id): id is number => id !== null)
    .slice(0, 60);

  if (requested.length === 0) return {};

  const requestedPlaceholders = requested.map(() => '?').join(', ');
  // Only messages in a conversation the caller is a *live* participant of right now — see
  // the docblock above for why this batched read cannot trust every id in the payload the
  // way Blabber's equivalent, over public posts, safely can.
  const visible = await Database.query<{ id: number }[]>(
    `SELECT m.\`id\` FROM \`gphone_messages\` m
     JOIN \`gphone_messages_participants\` p ON p.\`conversation_id\` = m.\`conversation_id\`
     WHERE m.\`id\` IN (${requestedPlaceholders}) AND p.\`citizenid\` = ? AND p.\`left_at\` IS NULL`,
    [...requested, citizenid]
  );
  const messageIds = visible.map((row) => row.id);
  if (messageIds.length === 0) return {};

  const placeholders = messageIds.map(() => '?').join(', ');
  const [counts, mine] = await Promise.all([
    Database.query<{ message_id: number; emoji: string; total: number }[]>(
      `SELECT \`message_id\`, \`emoji\`, COUNT(*) AS total FROM \`gphone_messages_reactions\`
       WHERE \`message_id\` IN (${placeholders})
       GROUP BY \`message_id\`, \`emoji\``,
      messageIds
    ),
    Database.query<{ message_id: number; emoji: string }[]>(
      `SELECT \`message_id\`, \`emoji\` FROM \`gphone_messages_reactions\`
       WHERE \`message_id\` IN (${placeholders}) AND \`citizenid\` = ?`,
      [...messageIds, citizenid]
    )
  ]);

  const out: Record<number, { counts: Record<string, number>; mine: string[] }> = {};
  for (const id of messageIds) out[id] = { counts: {}, mine: [] };
  for (const row of counts) out[row.message_id].counts[row.emoji] = Number(row.total);
  for (const row of mine) out[row.message_id].mine.push(row.emoji);
  return out;
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

    // Blocked (MICA-64): the row is still written — this only withholds the live push,
    // the same way an offline recipient's push is withheld above — so a client-side-only
    // block cannot be the whole story (§2.9, a modified client can already emit
    // `gphone:server:messages:send` directly). This is deliberately narrower than hiding
    // the message from the thread entirely, which is a larger, more decision-heavy
    // feature (does a block retroactively hide history already read? does the thread
    // itself disappear?) that this pass does not take a position on.
    if (sender.phone && (await isBlocked(participant.citizenid, sender.phone))) continue;

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
  const attachments = await resolveOwnedAttachments(body.attachments, citizenid, mediaRepo);
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
