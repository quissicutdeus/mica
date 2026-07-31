import { ConversationRepository } from '../repositories/ConversationRepository';
import { ServerApp } from '../lib/ServerApp';
import { Conversation } from '@shared/types';
import { Database } from '../lib/Database';
import { AuditLogger } from '../lib/AuditLogger';

const conversationRepo = new ConversationRepository();

const app = new ServerApp<Conversation>('conversations', conversationRepo, {
  disableGet: true,
  disableCreate: true, // Custom logic needed
  disableUpdate: false, // Default update is fine (renaming)
  disableDelete: true // Custom logic for soft delete/leave
});

// Get all conversations for the user
app.registerEvent('get', async (source, cbId, data, citizenid) => {
  const conversations = await conversationRepo.findForCitizen(citizenid);
  // Hydrate names for 1:1 logic
  for (const conv of conversations) {
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
  return conversations;
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

// Delete/Leave
app.registerEvent('delete', async (source, cbId, id, citizenid) => {
  // Check role
  const participants = await conversationRepo.findParticipants(id);
  const self = participants.find((p) => p.citizenid === citizenid);

  if (!self) throw new Error('Not a participant');

  if (self.role === 'admin') {
    // Admin deletes (soft delete)
    // Update conversation status = 'deleted'
    const success = await conversationRepo.update(id, { status: 'deleted' });
    if (success) {
      await AuditLogger.log({
        citizenid,
        action: 'deleted',
        controller: 'ConversationController',
        method: 'delete',
        targetId: Number(id),
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
      controller: 'ConversationController',
      method: 'delete',
      targetId: Number(id),
      targetTable: 'gphone_messages_participants'
    });
    return true;
  }
});
