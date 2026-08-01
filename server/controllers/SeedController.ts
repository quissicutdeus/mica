import { Database } from '../lib/Database';
import { FrameworkBridge } from '../lib/FrameworkBridge';
import { SEED_CHARACTERS, clearSeed, seedFor } from '../lib/seed';
import { deliverToParticipants } from './MessageController';
import { isAdmin } from './AdminController';

/**
 * `gphoneseed` — populate a dev server with someone to talk to.
 *
 * A fresh database has one character and no contacts, which makes most of the phone
 * untestable: you cannot start a conversation with a number nobody owns, and the fake
 * notification in Developer Tools only proves the toast renders.
 *
 * Admin-gated and reversible. See `lib/seed.ts` for what it writes and why the seeded
 * counterparts have to be real `players` rows.
 */

const respond = (source: number, message: string, type: 'success' | 'error' = 'success') => {
  if (source === 0) {
    console.log(`[gphoneseed] ${message}`);
    return;
  }
  emitNet('gphone:client:shell:notify', source, { type, title: 'Seed', message });
};

const citizenIdFor = (source: number): string | null =>
  FrameworkBridge.getPlayer(source)?.citizenid ?? null;

/** `gphoneseed text <firstname> <message…>` — have a seeded character text you. */
const runText = async (source: number, owner: string, args: string[]): Promise<void> => {
  const who = (args[1] ?? '').toLowerCase();
  const body = args.slice(2).join(' ').trim();

  const character = SEED_CHARACTERS.find((c) => c.firstname.toLowerCase() === who);
  if (!character) {
    const names = SEED_CHARACTERS.map((c) => c.firstname).join(', ');
    respond(source, `Unknown sender. Try one of: ${names}`, 'error');
    return;
  }
  if (!body) {
    respond(source, 'Usage: gphoneseed text <firstname> <message>', 'error');
    return;
  }

  const rows = await Database.query<{ conversation_id: number }[]>(
    `SELECT p.conversation_id
       FROM gphone_messages_participants p
       JOIN gphone_messages_participants q ON q.conversation_id = p.conversation_id
      WHERE p.citizenid = ? AND q.citizenid = ?
      LIMIT 1`,
    [owner, character.citizenid]
  );
  const conversationId = rows?.[0]?.conversation_id;
  if (!conversationId) {
    respond(source, 'No thread with them yet — run gphoneseed first.', 'error');
    return;
  }

  const result = await Database.query<any>(
    `INSERT INTO gphone_messages (conversation_id, citizenid, message, status)
     VALUES (?, ?, ?, 'active')`,
    [conversationId, character.citizenid, body]
  );

  // Goes out over the same path a real player's message does, which is the point: this
  // is how the inbound toast and the thread update get exercised without a second
  // person logged in.
  await deliverToParticipants(
    conversationId,
    character.citizenid,
    { name: `${character.firstname} ${character.lastname}`, phone: character.phone },
    {
      id: result?.insertId,
      conversation_id: conversationId,
      citizenid: character.citizenid,
      message: body,
      status: 'active'
    } as any
  );
};

const runSeedCommand = async (source: number, args: string[]): Promise<void> => {
  if (!isAdmin(source)) {
    respond(source, 'You do not have permission to use that.', 'error');
    return;
  }

  const sub = (args[0] ?? '').toLowerCase();

  if (sub === 'clear') {
    await clearSeed();
    respond(source, 'Seed data removed.');
    return;
  }

  const owner = citizenIdFor(source);
  if (!owner) {
    respond(source, 'Run this in game as a loaded character.', 'error');
    return;
  }

  if (sub === 'text') {
    await runText(source, owner, args);
    return;
  }

  if (sub && sub !== 'add') {
    respond(source, 'Usage: gphoneseed [add | text <firstname> <message> | clear]', 'error');
    return;
  }

  const { contacts, conversations } = await seedFor(owner);
  respond(source, `Seeded ${contacts} contact(s) and ${conversations} conversation(s).`);
};

RegisterCommand(
  'gphoneseed',
  (source: number, args: string[]) => {
    void runSeedCommand(source, args ?? []).catch((error) => {
      console.error('[gphoneseed] failed:', error);
      respond(source, 'Seeding failed — see the server console.', 'error');
    });
  },
  false
);
