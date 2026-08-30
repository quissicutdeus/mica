import { ConversationRepository } from '../repositories/ConversationRepository';
import { defineService } from '../lib/defineService';
import { Conversation } from '@shared/types';
import { Database } from '../lib/Database';
import { AuditLogger } from '../lib/AuditLogger';
import { resolveByPhone } from '../lib/PlayerDirectory';
import {
  conversationIdFrom,
  fields,
  flagUnlessFalse,
  isRecord,
  optionalString
} from '../lib/payload';

/**
 * Conversations: owner on both axes, with membership declared alongside.
 *
 * The row genuinely has an owner — `citizenid` is the creator — and renaming is
 * correctly restricted to them by the ownership-scoped generic update. What is shared
 * is *visibility*, and that is decided by the participants join table, which every
 * custom action below checks. Setting either axis to `members` would disable the generic
 * update and silently break rename.
 *
 * That split is exactly why `access` has two axes rather than one `scope`: this table
 * needs ownership-scoped writes *and* membership-scoped reads at the same time, which a
 * single value could not say.
 *
 * The participants join table is declared as a child table so `pnpm generate:sql`
 * emits a complete schema: it carries `role`, a different status enum, and two
 * nullable timestamps, none of which fit the primary-table shape.
 */
export const conversations = defineService<Conversation>({
  id: 'conversations',
  table: 'gphone_messages_conversations',
  access: {
    read: 'owner',
    write: 'owner',
    membership: {
      table: 'gphone_messages_participants',
      foreignKey: 'conversation_id',
      // A conversation's membership is keyed on its own id.
      localKey: 'id',
      liveWhileNull: 'left_at'
    }
  },
  statuses: ['active', 'archived', 'deleted', 'moderated'],
  schema: {
    // Derived by the custom create from the resolved member count, never client-writable
    // and never read from a payload. See the note on `isGroup` in the create handler.
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
        /**
         * One row per person per thread, enforced by the database rather than by the code
         * that writes it (MICA-153). Nothing adds a participant to an existing
         * conversation — `addParticipant` is reached only from `create`, and leaving a
         * thread and messaging that person again starts a new one — so there is no
         * rejoin this can refuse.
         *
         * It replaces the non-unique `conversation_participant`, which covered the same
         * two columns in the same order and is redundant beside it. The name had to
         * change: `SchemaMigrator` compares live indexes **by name only**
         * (`server/lib/migrate.ts`), so flipping the old one to unique in place would have
         * been a silent no-op on every server that already has it, leaving upgraded
         * installs permanently unlike fresh ones with nothing reporting it. Migration
         * `0001` does the drop and the add explicitly for the same reason.
         */
        {
          name: 'conversation_participant_unique',
          columns: ['conversation_id', 'citizenid'],
          unique: true
        },
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

/** So other services can reach the bespoke membership queries with types intact. */
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

/**
 * The most people one conversation may hold, the creator included.
 *
 * `participants` arrives as a raw client array, and every entry costs a `resolveByPhone`
 * query at create time and a net packet per message forever after
 * (`Messages.deliverToParticipants`). Unbounded, that is not a one-off cost but a
 * permanent amplifier attached to a thread. A hard constant rather than a convar, the
 * same call `proximity.MAX_NEARBY` makes: a server owner's dial belongs on things they
 * benefit from tuning, not on the ceiling for work a player can ask the server to do.
 *
 * A request over the cap is refused outright (see the check below `members` is built),
 * not silently truncated — a player who asked for 40 people and got 32 with no signal
 * which 8 were dropped would have no way to tell their group is incomplete.
 */
const MAX_CONVERSATION_MEMBERS = 32;

/** The UI sends either a citizenid or a whole contact object as `participant`. */
const nameOf = (participant: unknown): string | null => {
  if (!isRecord(participant)) return null;
  const first = optionalString(participant.firstname);
  const last = optionalString(participant.lastname);
  return first || last ? `${first ?? ''} ${last ?? ''}`.trim() : null;
};

// Create/Start conversation
app.registerEvent('create', async (source, cbId, data, citizenid) => {
  // The client chooses every field here except `is_group`, which is derived below, so each
  // is read once into a named local with the shape it is actually allowed to have.
  // `participant` is the second exception and stays loose: the UI sends either a whole
  // contact object (used only for its display name, below) or nothing. It is never trusted
  // as a citizenid — a raw citizenid is never proof the caller knows this person (§2.9),
  // and a modified client could otherwise force its way into a thread with anyone it can
  // guess an id for. A citizenid only ever becomes a participant by resolving through a
  // phone number, the same as the 1-on-1 path.
  const body = fields(data);
  const phone = optionalString(body.phone);
  const requestedName = optionalString(body.name);
  const participant = body.participant;

  let targetCitizenId: string | undefined;

  /**
   * Resolve the number to a person, online or off.
   *
   * This used to be forty lines here: two direct `exports[...]` calls bypassing
   * `FrameworkBridge`, a display name assembled inline from `charinfo`, and its own
   * `JSON_EXTRACT` fallback. It also carried a real defect — on a framework object with no
   * `PlayerData` it did `targetCitizenId = targetPlayer.phone_number`, putting a **phone
   * number** where a citizenid goes, and `gphone_messages_participants.citizenid` is a foreign
   * key onto `players`.
   */
  let targetName: string | null = null;
  if (phone) {
    const target = await resolveByPhone(phone);
    if (!target) {
      console.log(`[Conversation] No player holds phone ${phone}; refusing to start a thread.`);
      return null;
    }
    targetCitizenId = target.citizenid;
    targetName = target.displayName;
  }

  /**
   * Everyone who will be in the thread, the creator included.
   *
   * A `Set` because the derived `is_group` below is a count of *people*, and because
   * every duplicate here used to become its own live participant row. Deduplicating the
   * phone strings would not be enough on its own — two spellings of one number resolve
   * to the same citizenid — so the collapse happens on the resolved id.
   *
   * The requested list is deduplicated *before* any of it is resolved, so a payload
   * naming one number 500 times costs one lookup rather than 500.
   */
  const requestedPhones = Array.isArray(body.participants)
    ? body.participants.filter((p): p is string => typeof p === 'string')
    : [];
  const uniquePhones = [...new Set(requestedPhones)];

  const members = new Set<string>([citizenid]);
  if (targetCitizenId) members.add(targetCitizenId);

  /**
   * Refuse an oversized request outright, before any `resolveByPhone` call is spent on it.
   *
   * A silent truncation here would let a player ask for 100 people and quietly get 32 with
   * no indication which ones were dropped — worse than telling them up front. Checked
   * against the deduplicated phone count rather than the eventual resolved-citizenid count,
   * because that count is only known after doing the resolution work this check exists to
   * avoid; the one case that costs is several spellings of the same number in a request
   * that is already at the cap, which is not worth paying per-entry lookups to get exactly
   * right.
   */
  if (uniquePhones.length + members.size > MAX_CONVERSATION_MEMBERS) {
    throw new Error(`A conversation can hold at most ${MAX_CONVERSATION_MEMBERS} people.`);
  }

  // Group members: each entry is a phone number, resolved the same way the 1-on-1 target
  // is — never a raw citizenid, for the same reason `targetCitizenId` above isn't one.
  for (const memberPhone of uniquePhones) {
    const target = await resolveByPhone(memberPhone);
    if (!target) continue; // unknown number
    members.add(target.citizenid);
  }

  const others = [...members].filter((member) => member !== citizenid);

  /**
   * Derived from who is actually in the thread, and never read from the payload.
   *
   * `is_group` is a fact about the row rather than a property the caller owns, and the
   * Messages UI gates every affordance that would reveal an extra participant on it —
   * the member list, the group heading, the per-message sender name. A client that could
   * set it could therefore stand a third account inside a thread the victim is shown as
   * a private DM, and the victim had no surface anywhere in the app on which to discover
   * them (MICA-153).
   *
   * Deriving it repairs `findOneToOne` at the same time. That query filters on
   * `is_group = 0`, so a forged three-party thread could be handed back as the canonical
   * pair for any two people inside it; a thread with three members can no longer claim
   * to be a pair, because nothing but the member count decides the flag.
   */
  const isGroup = others.length > 1;

  // Logic for 1-on-1: existing check
  if (!isGroup && others.length === 1) {
    const existing = await conversationRepo.findOneToOne(citizenid, others[0]);
    if (existing) return existing;
  }

  // Create new
  const newConv: Partial<Conversation> = {
    citizenid: citizenid,
    is_group: isGroup,
    // Provided name, or the one resolved from the phone, or the contact object the UI
    // sometimes sends instead of a citizenid.
    name: requestedName ?? targetName ?? nameOf(participant) ?? undefined
  };
  let conversationId = await conversationRepo.createConversation(newConv);

  await conversationRepo.addParticipant(conversationId, citizenid, 'admin');
  for (const memberCitizenId of others) {
    await conversationRepo.addParticipant(conversationId, memberCitizenId, 'member');
  }

  /**
   * The `findOneToOne` above and the `create` below it are two round trips, and two people
   * opening a chat with each other at the same moment both miss and both create. No attacker
   * is needed; this is the ordinary case (MICA-156). Messages then split across two threads
   * with no way to merge them, because each player may hold the id the other is not writing
   * to.
   *
   * Reconciling here rather than guarding the insert, because a conversation is only *a
   * pair* once its participant rows exist — which is after the insert. By this line both
   * racers are visible to each other, and both resolve the same lowest id, so the loser
   * stands down and returns the winner. It narrows the window rather than closing it; the
   * residue needs a uniquely-indexed pair key, tracked as MICA-156's second half.
   */
  if (!isGroup && others.length === 1) {
    conversationId = await conversationRepo.reconcilePairDuplicate(
      conversationId,
      citizenid,
      others[0]
    );
  }

  console.log(
    `[Conversation] Created conversation ${conversationId} with ${members.size} participant(s).`
  );

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
  const archive = flagUnlessFalse(fields(data).archive);
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
        service: 'conversations',
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
      service: 'conversations',
      method: 'delete',
      targetId: id,
      targetTable: 'gphone_messages_participants'
    });
    return true;
  }
});
