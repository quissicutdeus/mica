import { Database } from './Database';

/**
 * Seed data for testing the phone against something other than an empty database.
 *
 * The problem this solves: with one character on a dev server there is nobody to text.
 * `ConversationController.create` resolves a phone number to a `citizenid` and gives up
 * when it cannot, and `gphone_messages_participants.citizenid` is a foreign key onto
 * `players` — so a conversation counterpart has to be a real row in `players`, not a
 * made-up string.
 *
 * So the seed creates characters. They are marked by their license (`SEED_LICENSE`) and
 * by a `citizenid` prefix, which is what lets `clearSeed` find and remove exactly its own
 * rows and nothing a person made.
 *
 * Nothing here runs automatically. It is reachable only through the `gphoneseed` command,
 * which is admin-gated.
 */

/** Marks a `players` row as ours. Nothing else in the database uses this license. */
const SEED_LICENSE = 'license:gphoneseed';

/** Every seeded citizenid starts with this. */

export interface SeedCharacter {
  citizenid: string;
  firstname: string;
  lastname: string;
  phone: string;
}

export const SEED_CHARACTERS: readonly SeedCharacter[] = [
  { citizenid: 'SEED0001', firstname: 'Marla', lastname: 'Vance', phone: '5550101' },
  { citizenid: 'SEED0002', firstname: 'Dez', lastname: 'Okonkwo', phone: '5550102' },
  { citizenid: 'SEED0003', firstname: 'Rhys', lastname: 'Calloway', phone: '5550103' },
  { citizenid: 'SEED0004', firstname: 'Junie', lastname: 'Park', phone: '5550104' }
];

/** Opening messages, so a seeded thread has something in it. */
const OPENERS: Record<string, string[]> = {
  SEED0001: ['hey, you around?', 'got that thing sorted or not'],
  SEED0002: ['yo', 'meet me at the docks in 10'],
  SEED0003: ['wrong number sorry'],
  SEED0004: ['did you see what happened on vinewood?', 'wild']
};

const findByCitizenId = async (citizenid: string): Promise<number | null> => {
  const rows = await Database.query<{ id: number }[]>(
    'SELECT id FROM players WHERE citizenid = ? LIMIT 1',
    [citizenid]
  );
  return rows?.[0]?.id ?? null;
};

/**
 * Create the seed characters in `players`.
 *
 * Only the NOT NULL columns are populated. These are not playable characters — they exist
 * so the foreign keys hold and so phone lookups resolve.
 */
const createCharacters = async (): Promise<void> => {
  for (const character of SEED_CHARACTERS) {
    if (await findByCitizenId(character.citizenid)) continue;

    const charinfo = JSON.stringify({
      firstname: character.firstname,
      lastname: character.lastname,
      phone: character.phone,
      birthdate: '1990-01-01',
      gender: 0,
      nationality: 'Seeded'
    });

    await Database.query(
      `INSERT INTO players
         (citizenid, license, name, money, charinfo, job, position, metadata, phone_number)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        character.citizenid,
        SEED_LICENSE,
        `${character.firstname} ${character.lastname}`,
        JSON.stringify({ cash: 0, bank: 0 }),
        charinfo,
        JSON.stringify({ name: 'unemployed', label: 'Civilian', grade: { level: 0 } }),
        JSON.stringify({ x: 0, y: 0, z: 70 }),
        JSON.stringify({}),
        character.phone
      ]
    );
  }
};

/** Add the seed characters to a player's address book. */
const createContacts = async (owner: string): Promise<number> => {
  let added = 0;
  for (const character of SEED_CHARACTERS) {
    const existing = await Database.query<{ id: number }[]>(
      'SELECT id FROM gphone_contacts WHERE citizenid = ? AND phone = ? LIMIT 1',
      [owner, character.phone]
    );
    if (existing?.length) continue;

    await Database.query(
      `INSERT INTO gphone_contacts (citizenid, firstname, lastname, phone, status)
       VALUES (?, ?, ?, ?, 'active')`,
      [owner, character.firstname, character.lastname, character.phone]
    );
    added += 1;
  }
  return added;
};

/**
 * Open a thread with each seed character and put their opening messages in it.
 *
 * The messages come from the seed side only. The player's own replies are the thing being
 * tested, so seeding them would just be noise.
 */
const createConversations = async (owner: string): Promise<number> => {
  let created = 0;

  for (const character of SEED_CHARACTERS) {
    const openers = OPENERS[character.citizenid] ?? [];
    if (openers.length === 0) continue;

    const existing = await Database.query<{ conversation_id: number }[]>(
      `SELECT p.conversation_id
         FROM gphone_messages_participants p
         JOIN gphone_messages_participants q ON q.conversation_id = p.conversation_id
        WHERE p.citizenid = ? AND q.citizenid = ?
        LIMIT 1`,
      [owner, character.citizenid]
    );
    if (existing?.length) continue;

    const result = await Database.query<any>(
      `INSERT INTO gphone_messages_conversations (citizenid, is_group, name, status)
       VALUES (?, 0, NULL, 'active')`,
      [owner]
    );
    const conversationId = result?.insertId;
    if (!conversationId) continue;

    for (const citizenid of [owner, character.citizenid]) {
      await Database.query(
        `INSERT INTO gphone_messages_participants
           (conversation_id, citizenid, role, status, left_at)
         VALUES (?, ?, 'member', 'active', NULL)`,
        [conversationId, citizenid]
      );
    }

    for (const body of openers) {
      await Database.query(
        `INSERT INTO gphone_messages (conversation_id, citizenid, message, status)
         VALUES (?, ?, ?, 'active')`,
        [conversationId, character.citizenid, body]
      );
    }

    created += 1;
  }

  return created;
};

export interface SeedResult {
  characters: number;
  contacts: number;
  conversations: number;
}

/** Everything a player needs to have someone to text. Safe to run more than once. */
export const seedFor = async (owner: string): Promise<SeedResult> => {
  await createCharacters();
  const contacts = await createContacts(owner);
  const conversations = await createConversations(owner);
  return { characters: SEED_CHARACTERS.length, contacts, conversations };
};

/**
 * Remove everything the seed created, everywhere.
 *
 * Scoped by the seed citizenids rather than by owner: the rows are only ever reachable
 * through a seeded character, and leaving orphaned `players` rows behind would break the
 * next `seedFor`. Real characters are never matched — no genuine citizenid is in
 * `SEED_CHARACTERS`, and the `players` delete additionally requires the seed license.
 */
export const clearSeed = async (): Promise<void> => {
  const ids = SEED_CHARACTERS.map((c) => c.citizenid);
  const placeholders = ids.map(() => '?').join(',');

  const conversations = await Database.query<{ conversation_id: number }[]>(
    `SELECT DISTINCT conversation_id FROM gphone_messages_participants
      WHERE citizenid IN (${placeholders})`,
    ids
  );
  const conversationIds = (conversations ?? []).map((row) => row.conversation_id);

  if (conversationIds.length > 0) {
    const convPlaceholders = conversationIds.map(() => '?').join(',');
    // Children first: both tables carry a foreign key onto the conversation.
    await Database.query(
      `DELETE FROM gphone_messages WHERE conversation_id IN (${convPlaceholders})`,
      conversationIds
    );
    await Database.query(
      `DELETE FROM gphone_messages_participants WHERE conversation_id IN (${convPlaceholders})`,
      conversationIds
    );
    await Database.query(
      `DELETE FROM gphone_messages_conversations WHERE id IN (${convPlaceholders})`,
      conversationIds
    );
  }

  const phones = SEED_CHARACTERS.map((c) => c.phone);
  await Database.query(
    `DELETE FROM gphone_contacts WHERE phone IN (${phones.map(() => '?').join(',')})`,
    phones
  );

  await Database.query(`DELETE FROM players WHERE license = ? AND citizenid IN (${placeholders})`, [
    SEED_LICENSE,
    ...ids
  ]);
};
