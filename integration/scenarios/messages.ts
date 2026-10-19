// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Scenario } from '../runner';
import { db } from '../lib/db';
import { call, invoke, pushes, seedPlayer, waitForPush, type PushEnvelope } from '../lib/door';
import { assert, harnessKeys, HARNESS_KID, seedCitizen, unique, type Citizen } from '../lib/mica';
import { openSealed, sealedKid } from '../lib/sealed';
import { schemaCreated } from './qbx';

/**
 * Messages, the core of the phone, inside a real FXServer on a real MariaDB (MICA-397).
 *
 * A player's text is `conversations:create` to a number and then `messages:send` into that
 * thread, both driven through the integration door (`../lib/door.ts`) as synthetic players. The
 * door installs its players into `FrameworkBridge`, so `send`'s MICA-336 guard, which asks the
 * bridge who the source is after the number is read, gets an answer for them. The recipient's
 * live push is `mica:client:messages:received`, a net event to their source, which the door
 * keeps as `{ app: 'net', event, payload }`.
 *
 * Standalone only: the door's players hold no phone item, and `send` requires one when
 * `mica_phone_item` is set, which the qbx and esx runs do.
 *
 * Fixtures are fresh `unique()` citizens and are left in place, as the crypto scenarios leave
 * theirs: a thread's rows are bound to each other by foreign keys, and nothing here reads
 * anybody else's.
 */

const RECEIVED = 'mica:client:messages:received';

/** How long a push that follows the reply may take to be captured. */
const PUSH_WAIT_MS = 3_000;

/** The replies, as the contracts declare them. Restated, not imported. */
interface Thread {
  id: number;
}
interface SentRow {
  id: number;
  conversation_id: number;
  mine: boolean;
  message: string;
}
interface Refusal {
  error: string;
  key?: string;
}

const show = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

/** A citizen with a number, seeded as a synthetic player the door can act as. */
const withNumber = async (label: string): Promise<Citizen> => {
  const citizen = await seedCitizen(label);
  await seedPlayer(citizen.citizenid, 0);
  return citizen;
};

/** Start a 1:1 from `from` to `number`, failing on anything but a thread. */
const openThread = async (from: string, number: string): Promise<number> => {
  const { result } = await call<Thread | null>('conversations', 'create', from, { phone: number });
  const id = Number(result?.id);
  assert(Number.isSafeInteger(id) && id > 0, `conversations:create answered ${show(result)}`);
  return id;
};

const send = async (from: string, conversationId: number, message: string) =>
  await invoke<SentRow | Refusal | null>('messages', 'send', from, {
    conversation_id: conversationId,
    message
  });

/** A `send` reply that is the stored row, read as the sender reads it. */
const assertSent = (result: unknown, conversationId: number, body: string): SentRow => {
  const row = result as SentRow | null;
  assert(
    Number.isSafeInteger(row?.id) && row!.conversation_id === conversationId,
    `messages:send answered ${show(result)}, not a row in conversation ${conversationId}`
  );
  assert(row!.mine === true, 'the sender was handed their own text as not theirs');
  assert(row!.message === body, 'the reply carried another body than the one sent');
  return row!;
};

const isReceivedIn =
  (conversationId: number) =>
  (envelope: PushEnvelope): boolean =>
    envelope.app === 'net' &&
    envelope.event === RECEIVED &&
    Number(envelope.payload?.conversation_id) === conversationId;

/** The stored row, its body opened with the harness key under its own citizen and thread. */
const storedText = async (
  id: number
): Promise<{ citizenid: string; conversationId: number; body: string }> => {
  const row = await db.row(
    'SELECT `citizenid`, `conversation_id`, `message`, `status` FROM `mica_messages` WHERE `id` = ?',
    [id]
  );
  if (!row) throw new Error(`mica_messages row ${id} is not there`);
  assert(row.status === 'active', `mica_messages row ${id} is '${String(row.status)}'`);
  const stored = String(row.message);
  assert(sealedKid(stored) === HARNESS_KID, `row ${id}'s body is not sealed with '${HARNESS_KID}'`);
  const citizenid = String(row.citizenid);
  const conversationId = Number(row.conversation_id);
  const body = openSealed(stored, harnessKeys(), {
    table: 'mica_messages',
    column: 'message',
    citizenid,
    scope: [conversationId]
  });
  return { citizenid, conversationId, body };
};

const liveMembers = async (conversationId: number): Promise<string[]> =>
  (
    await db.rows(
      'SELECT `citizenid` FROM `mica_messages_participants` ' +
        "WHERE `conversation_id` = ? AND (`status` IS NULL OR `status` = 'active') " +
        'ORDER BY `citizenid`',
      [conversationId]
    )
  ).map((row) => String(row.citizenid));

export const messagesScenarios: readonly Scenario[] = [
  {
    // MICA-397: a text from one citizen with a number to another is written, sealed, to
    // `mica_messages` in a thread holding both of them, and is pushed live to the recipient
    // carrying the sender's number and not their citizenid (MICA-339). The sender is pushed
    // nothing for their own text.
    id: 'messages-send-writes-the-row-and-pushes-the-recipient',
    mode: 'standalone',
    tickets: ['MICA-397'],
    run: async (signal) => {
      await schemaCreated(signal);
      const sender = await withNumber('msg_from');
      const recipient = await withNumber('msg_to');

      const conversationId = await openThread(sender.citizenid, recipient.number);
      const members = await liveMembers(conversationId);
      const both = [sender.citizenid, recipient.citizenid].sort();
      assert(
        show(members) === show(both),
        `conversation ${conversationId} holds ${show(members)}, not ${show(both)}`
      );

      const body = `integration ${unique('text')} ✓`;
      const { result } = await send(sender.citizenid, conversationId, body);
      const sent = assertSent(result, conversationId, body);

      const stored = await storedText(sent.id);
      assert(
        stored.citizenid === sender.citizenid,
        `row ${sent.id} belongs to ${stored.citizenid}`
      );
      assert(stored.conversationId === conversationId, `row ${sent.id} is in another thread`);
      assert(stored.body === body, 'the stored body opened to something else');

      const push = await waitForPush(
        recipient.citizenid,
        isReceivedIn(conversationId),
        PUSH_WAIT_MS,
        signal,
        `the recipient's ${RECEIVED} for conversation ${conversationId}`
      );
      assert(push.payload.message === body, `the push carried ${show(push.payload.message)}`);
      assert(
        push.payload.phone === sender.number,
        `the push named ${show(push.payload.phone)}, not the sender's ${sender.number}`
      );
      const row = push.payload.row as SentRow | undefined;
      assert(row?.id === sent.id && row.mine === false, `the push's row is ${show(row)}`);
      assert(
        !show(push.payload).includes(sender.citizenid),
        "the recipient's push carries the sender's citizenid"
      );

      // The negative twin of the push above: the sender's own buffer has no copy of it.
      const own = (await pushes(sender.citizenid)).filter(isReceivedIn(conversationId));
      assert(own.length === 0, `the sender was pushed their own text ${own.length} time(s)`);
    }
  },
  {
    // MICA-397, MICA-346: on standalone a text is never sent with no number. A sender with no
    // number row has the sync awaited first, which issues one, and the text goes out from it:
    // the push names that number and `mica_phone_numbers` holds it for the sender.
    id: 'messages-send-issues-a-numberless-sender-a-number-first',
    mode: 'standalone',
    tickets: ['MICA-397', 'MICA-346'],
    run: async (signal) => {
      await schemaCreated(signal);
      const sender = unique('msg_numberless');
      await seedPlayer(sender, 0);
      const before = await db.count(
        'SELECT COUNT(*) FROM `mica_phone_numbers` WHERE `citizenid` = ?',
        [sender]
      );
      assert(before === 0, `the numberless sender already holds ${before} number(s)`);
      const recipient = await withNumber('msg_to_numberless');

      const conversationId = await openThread(sender, recipient.number);
      const body = `integration ${unique('first_text')}`;
      const { result } = await send(sender, conversationId, body);
      assertSent(result, conversationId, body);

      const issued = await db.rows(
        'SELECT `number` FROM `mica_phone_numbers` WHERE `citizenid` = ?',
        [sender]
      );
      assert(issued.length === 1, `the sender holds ${issued.length} numbers after a text`);
      const number = String(issued[0].number);

      const push = await waitForPush(
        recipient.citizenid,
        isReceivedIn(conversationId),
        PUSH_WAIT_MS,
        signal,
        `the recipient's ${RECEIVED} from the newly numbered sender`
      );
      assert(
        push.payload.phone === number,
        `the push named ${show(push.payload.phone)}, not the issued ${number}`
      );
    }
  },
  {
    // MICA-397, §2.9: a conversation id is never authorization. A citizen who is not in the
    // thread is refused with `server.messages.notParticipant`, nothing is written under their
    // name, and nobody in the thread is pushed anything.
    id: 'messages-send-refuses-a-citizen-outside-the-thread',
    mode: 'standalone',
    tickets: ['MICA-397'],
    run: async (signal) => {
      await schemaCreated(signal);
      const sender = await withNumber('msg_owner');
      const recipient = await withNumber('msg_member');
      const outsider = await withNumber('msg_outsider');
      const conversationId = await openThread(sender.citizenid, recipient.number);

      const { result } = await send(outsider.citizenid, conversationId, 'not yours');
      const refusal = result as Refusal | null;
      assert(
        refusal?.key === 'server.messages.notParticipant',
        `an outsider's send answered ${show(result)}, not server.messages.notParticipant`
      );
      const written = await db.count(
        'SELECT COUNT(*) FROM `mica_messages` WHERE `conversation_id` = ?',
        [conversationId]
      );
      assert(written === 0, `${written} message(s) were written by a refused send`);
      const told = (await pushes(recipient.citizenid)).filter(isReceivedIn(conversationId));
      assert(told.length === 0, `a member was pushed ${told.length} text(s) from a refused send`);

      // The positive twin: a member's text into the same thread is written.
      const { result: member } = await send(sender.citizenid, conversationId, 'yours');
      assertSent(member, conversationId, 'yours');
    }
  }
];
