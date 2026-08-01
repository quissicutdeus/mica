import { ConversationRepository } from '../repositories/ConversationRepository';
import { defineServerApp } from '../lib/defineServerApp';
import { Conversation } from '@shared/types';
import { Database } from '../lib/Database';
import { AuditLogger } from '../lib/AuditLogger';
import { conversationIdFrom } from '../lib/payload';

/**
 * Conversations: owner scope, deliberately not `shared`.
 *
 * The row genuinely has an owner — `citizenid` is the creator — and renaming is
 * correctly restricted to them by the ownership-scoped generic update. What is shared
 * is *visibility*, and that is decided by the participants join table, which every
 * custom action below checks. Declaring this `shared` would disable the generic
 * update and silently break rename.
 *
 * The participants join table is declared as a child table so `pnpm generate:sql`
 * emits a complete schema: it carries `role`, a different status enum, and two
 * nullable timestamps, none of which fit the primary-table shape.
 */
export const conversations = defineServerApp<Conversation>({
  id: 'conversations',
  table: 'gphone_messages_conversations',
  scope: 'owner',
  statuses: ['active', 'archived', 'deleted', 'moderated'],
  schema: {
    // Set by the custom create; never client-writable.
    is_group: { type: 'bool', notNull: true, default: 0, clientWritable: false },
    // The only generic write. `update` scopes it to the creator.
    name: { type: 'string', length: 50 }
  },
  indexes: [
    { name: 'citizenid_status_updated', columns: ['citizenid', 'status', 'updated_at'] },
    { name: 'updated_at', columns: ['updated_at'] }
  ],
  childTables: [
    {
      name: 'gphone_messages_participants',
      columns: {
        conversation_id: {
          type: 'int',
          notNull: true,
          references: { table: 'gphone_messages_conversations', column: 'id' }
        },
        citizenid: {
          type: 'string',
          length: 50,
          notNull: true,
          references: { table: 'players', column: 'citizenid' }
        },
        role: { type: 'string', length: 20, notNull: true, default: 'member' },
        status: {
          type: 'enum',
          values: ['active', 'left', 'removed', 'moderated'],
          notNull: true,
          default: 'active'
        },
        last_read: { type: 'timestamp', notNull: true, defaultNow: true },
        created_at: { type: 'timestamp', notNull: true, defaultNow: true },
        // Null means "still in the thread" — every membership check filters on it.
        left_at: { type: 'timestamp' },
        // Archiving is per-participant: hiding a thread from your own list must not
        // hide it from everyone else's. A separate column rather than a `status`
        // value, because every membership check filters on `status = 'active'` and an
        // archived participant is still very much in the conversation.
        archived_at: { type: 'timestamp' },
        updated_at: { type: 'timestamp', notNull: true, defaultNow: true, onUpdateNow: true }
      },
      indexes: [
        { name: 'status', columns: ['status'] },
        { name: 'conversation_participant', columns: ['conversation_id', 'citizenid'] },
        { name: 'citizenid_status', columns: ['citizenid', 'status'] },
        { name: 'conversation_status', columns: ['conversation_id', 'status'] },
        { name: 'participant_last_read', columns: ['citizenid', 'last_read'] }
      ]
    }
  ],
  options: {
    disableGet: true, // Custom: hydrates participants and unread counts
    disableCreate: true, // Custom: resolves a phone number to a citizenid
    disableDelete: true // Custom: admin soft-deletes, everyone else leaves
  },
  repositoryFactory: (resolved) => new ConversationRepository(resolved)
});

/** So other controllers can reach the bespoke membership queries with types intact. */
export type ConversationRepo = ConversationRepository;

const app = conversations.app;
const conversationRepo = conversations.repo as ConversationRepository;

// Get all conversations for the user
app.registerEvent('get', async (source, cbId, data, citizenid) => {
  // Named `list`, not `conversations`: the module-level export of that name is the
  // app handle, and shadowing it here would be a trap for the next reader.
  const list = await conversationRepo.findForCitizen(citizenid);
  // Hydrate names for 1:1 logic
  for (const conv of list) {
    const participants = await hydrateParticipants(conv.id);
    // Map simplified participants with names
    conv.participants = participants.map((p) => ({
      ...p,
      contact: {
        firstname: p.firstname,
        lastname: p.lastname,
        phone: p.phone,
        citizenid: p.citizenid,
        id: 0,
        favorite: false,
        created_at: new Date(),
        updated_at: new Date()
      } // Mocking contact structure for UI convenience
    }));
  }
  return list;
});

// Helper to find citizenid by phone (Offline fallback)
const findCitizenIdByPhone = async (phone: string): Promise<string | null> => {
  // Assuming QB-Core standard schema: players table with charinfo JSON column
  const query = `
        SELECT citizenid 
        FROM players 
        WHERE JSON_UNQUOTE(JSON_EXTRACT(charinfo, '$.phone')) = ?
        LIMIT 1
    `;
  return await Database.scalar<string>(query, [phone]);
};

// Helper to hydrate participants with names
const hydrateParticipants = async (conversationId: number) => {
  const query = `
        SELECT p.*, 
        JSON_UNQUOTE(JSON_EXTRACT(pl.charinfo, '$.firstname')) as firstname,
        JSON_UNQUOTE(JSON_EXTRACT(pl.charinfo, '$.lastname')) as lastname,
        JSON_UNQUOTE(JSON_EXTRACT(pl.charinfo, '$.phone')) as phone
        FROM gphone_messages_participants p
        LEFT JOIN players pl ON p.citizenid = pl.citizenid
        WHERE p.conversation_id = ? AND p.left_at IS NULL
    `;
  return await Database.query<any[]>(query, [conversationId]);
};

// Create/Start conversation
app.registerEvent('create', async (source, cbId, data, citizenid) => {
  // data: { is_group, name, participants: [], participant: string, phone: string }

  let targetCitizenId = data.participant;

  // Resolve phone to citizenid if needed
  let targetName = null;
  if (!data.is_group && data.phone) {
    let targetPlayer: any = null;
    try {
      if (exports['qbx_core']?.GetPlayerByPhone) {
        targetPlayer = exports['qbx_core'].GetPlayerByPhone(data.phone);
      } else if (exports['qb-core']?.GetCoreObject) {
        targetPlayer = exports['qb-core'].GetCoreObject().Functions.GetPlayerByPhone(data.phone);
      }
    } catch (e) {
      targetPlayer = null;
    }

    if (targetPlayer) {
      // Online player logic
      if (targetPlayer.PlayerData) {
        targetCitizenId = targetPlayer.PlayerData.citizenid;
        if (targetPlayer.PlayerData.charinfo) {
          targetName = `${targetPlayer.PlayerData.charinfo.firstname} ${targetPlayer.PlayerData.charinfo.lastname}`;
        }
      } else if (targetPlayer.phone_number) {
        targetCitizenId = targetPlayer.phone_number;
      }
      console.log(`[Conversation] Resolved phone ${data.phone} to ${targetCitizenId} via QBX`);
    } else {
      // Offline fallback
      console.log(
        `[Conversation] Player offline for phone ${data.phone}. Attempting SQL fallback...`
      );
      const fallbackId = await findCitizenIdByPhone(data.phone);
      if (fallbackId) {
        targetCitizenId = fallbackId;
        console.log(
          `[Conversation] Resolved phone ${data.phone} to ${targetCitizenId} via SQL fallback`
        );
      } else {
        console.log(`[Conversation] Could not resolve phone ${data.phone} via QBX or SQL`);
        return null;
      }
    }
  }

  // Logic for 1-on-1: existing check
  if (!data.is_group && targetCitizenId) {
    const existing = await conversationRepo.findOneToOne(citizenid, targetCitizenId);
    if (existing) return existing;
  }

  // Create new
  const newConv: Partial<Conversation> = {
    citizenid: citizenid,
    is_group: !!data.is_group,
    // Use provided name, or resolved name, or fallback to data.participant logic (safely)
    name:
      data.name ||
      targetName ||
      (typeof data.participant === 'object'
        ? `${data.participant.firstname} ${data.participant.lastname}`
        : null)
  };
  const conversationId = await conversationRepo.createConversation(newConv);
  console.log(`[Conversation] Created conversation ${conversationId}, adding participants.`);

  // Add self
  await conversationRepo.addParticipant(conversationId, citizenid, 'admin');
  console.log(`[Conversation] Added self (${citizenid}) to ${conversationId}`);

  // Add others
  // If 1-on-1
  if (targetCitizenId) {
    console.log(`[Conversation] Adding target (${targetCitizenId}) to ${conversationId}`);
    await conversationRepo.addParticipant(conversationId, targetCitizenId, 'member');
  } else {
    console.log(`[Conversation] No targetCitizenId found (payload: ${JSON.stringify(data)})`);
  }

  // If group list (assuming they are already citizenids for now, or we recursively resolve them)
  if (data.participants && Array.isArray(data.participants)) {
    for (const p of data.participants) {
      if (p !== citizenid) {
        // Avoid double add
        await conversationRepo.addParticipant(conversationId, p, 'member');
      }
    }
  }

  return { ...newConv, id: conversationId };
});

// Mark this participant's thread as read. Scoped to the caller's own membership.
app.registerEvent('read', async (source, cbId, data, citizenid) => {
  const id = conversationIdFrom(data);
  return await conversationRepo.markRead(id, citizenid);
});

/**
 * Archive or unarchive a thread, for the caller only.
 *
 * The web has offered this from two places since Messages shipped and it reached
 * nothing — no client route, no server handler — while the browser mock answered it
 * happily. Scoped to the caller's own participant row, so the WHERE clause is the
 * authorization: there is no id a player can pass that touches someone else's view.
 */
app.registerEvent('archive', async (source, cbId, data, citizenid) => {
  const id = conversationIdFrom(data);
  const archive = data?.archive !== false;
  return await conversationRepo.setArchived(id, citizenid, archive);
});

// Delete/Leave
app.registerEvent('delete', async (source, cbId, data, citizenid) => {
  const id = conversationIdFrom(data);

  // Check role
  const participants = await conversationRepo.findParticipants(id);
  const self = participants.find((p) => p.citizenid === citizenid);

  if (!self) throw new Error('Not a participant');

  if (self.role === 'admin') {
    // Admin deletes (soft delete) on behalf of the whole thread, so this is a
    // privileged write: the actor is not necessarily the row's citizenid.
    const success = await conversationRepo.markDeletedByAdmin(id);
    if (success) {
      await AuditLogger.log({
        citizenid,
        action: 'deleted',
        controller: 'conversations',
        method: 'delete',
        targetId: id,
        targetTable: 'gphone_messages_conversations'
      });
    }
    return success;
  } else {
    // Insert new row with status 'left' (Left Voluntarily)
    await conversationRepo.removeParticipant(id, citizenid, 'left');
    await AuditLogger.log({
      citizenid,
      action: 'left',
      controller: 'conversations',
      method: 'delete',
      targetId: id,
      targetTable: 'gphone_messages_participants'
    });
    return true;
  }
});
