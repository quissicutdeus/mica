// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Scenario } from '../runner';
import { db } from '../lib/db';
import { call, invoke, pushes, seedPlayer, waitForPush, type PushEnvelope } from '../lib/door';
import { assert, HARNESS_KID, harnessKeys, unique } from '../lib/mica';
import { openSealed, sealedKid } from '../lib/sealed';
import { eventually, type Signal } from '../lib/wait';
import { schemaCreated } from './qbx';

/**
 * Direct messages on the shared `dms` service (MICA-390, `server/services/DirectMessages.ts`)
 * inside a real FXServer on a real MariaDB, driven through the integration door (MICA-397).
 *
 * The service is owned by no app: every action names the app its two accounts live in, and a
 * policy the app registered decides who may message whom there. Blabber and Glimpse (MICA-393)
 * both register an open one. So every scenario here seeds two synthetic citizens, claims each an
 * account through `accounts:create` (the action a player's phone uses), and then sends, reads
 * and lists as those accounts, checking each reply against what the table holds.
 *
 * `send` is a `requirePhoneFor` action. The door's players hold no phone item, so these run only
 * in the standalone run, where `mica_phone_item` is unset.
 *
 * Every push a scenario waits for is read straight after the send that caused it: the door's
 * `waitForPush` drains what it reads, so a push sent before the one being waited for is gone.
 */

const DMS = 'dms';
const ACCOUNTS = 'accounts';
const TABLE = 'mica_blabber_dms';

/** The service's own refusals, as `DirectMessages.ts` raises them. Restated, not imported. */
const REFUSED = {
  noPolicy: { key: 'server.dms.noPolicy', error: "This app doesn't support direct messages." },
  notYours: { key: 'server.blabberDms.notYours', error: 'That account is not yours.' },
  notYoursToSend: {
    key: 'server.blabberDms.notYoursToSend',
    error: 'That account is not yours to send from.'
  },
  selfMessage: { key: 'server.blabberDms.selfMessage', error: 'You cannot message yourself.' },
  emptyMessage: {
    key: 'server.blabberDms.emptyMessage',
    error: 'A message needs something in it.'
  },
  // One answer for a missing peer, a peer in another app, a block either way and a policy's
  // no (MICA-255): a refusal must not tell the sender which rule it was.
  blocked: { key: 'server.blabberDms.blocked', error: "You can't message this account." }
} as const;

interface AccountRef {
  id: number;
  citizenid: string;
  app: string;
  handle: string;
}

/** A DM as `send` and `get` answer it. */
interface Dm {
  id: number;
  from_account: number;
  to_account: number;
  body: string;
  read_at?: unknown;
  status?: string;
  citizenid?: unknown;
}

interface Thread {
  peer_account_id: number;
  handle: string | null;
  display_name: string | null;
  last: Dm | null;
  unread: number;
}

/** What the door hands back beside `PushEnvelope`'s fields: the real envelope carries these. */
type DmPush = PushEnvelope & {
  deepLink?: unknown;
  notify?: { title?: unknown; message?: unknown } | null;
  persisted?: unknown;
};

/** Null as sent; a value that crossed a resource boundary may arrive as undefined instead. */
const isNil = (value: unknown): boolean => value === null || value === undefined;

const show = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

/** Claim `citizenid` an account in `app` the way the phone does, and check the table took it. */
const claimAccount = async (citizenid: string, app: string): Promise<AccountRef> => {
  // `itx_<run>_<n>_h`: lowercase, digits and `_`, well under 32 — the handle rule's alphabet.
  const handle = unique('h');
  const { result } = await call<{ id?: unknown; app?: unknown; handle?: unknown }>(
    ACCOUNTS,
    'create',
    citizenid,
    { app, handle }
  );
  const id = Number(result?.id);
  assert(
    Number.isSafeInteger(id) && id > 0 && result?.app === app && result?.handle === handle,
    `accounts:create of @${handle} on ${app} answered ${show(result)}, not that account`
  );
  const row = await db.row(
    'SELECT `citizenid`, `app`, `handle`, `status` FROM `mica_accounts` WHERE `id` = ?',
    [id]
  );
  assert(
    row?.citizenid === citizenid && row?.app === app && row?.status === 'active',
    `mica_accounts row ${id} holds ${show(row)}, not an active ${app} account of ${citizenid}`
  );
  return { id, citizenid, app, handle };
};

const send = async (from: AccountRef, to: number, body: string, app = from.app) =>
  await invoke<Dm | Record<string, unknown>>(DMS, 'send', from.citizenid, {
    app,
    account_id: from.id,
    peer_account_id: to,
    body
  });

/** A send that must land: the reply is the row, for these two accounts, with the body trimmed. */
const sendOk = async (from: AccountRef, to: AccountRef, body: string): Promise<Dm> => {
  const { result } = await send(from, to.id, body);
  const dm = result as Dm;
  assert(
    Number.isSafeInteger(dm?.id) &&
      dm.id > 0 &&
      dm.from_account === from.id &&
      dm.to_account === to.id &&
      dm.body === body.trim() &&
      isNil(dm.read_at) &&
      dm.status === 'active',
    `${from.app} @${from.handle} -> @${to.handle} answered ${show(result)}; expected the new ` +
      `active, unread row from ${from.id} to ${to.id} with the trimmed body`
  );
  assert(!('citizenid' in dm), `send's reply carries the sender's citizenid: ${show(dm)}`);
  return dm;
};

/** An `{ error, key }` answer carrying exactly the service's words and catalog key. */
const assertRefused = (
  result: unknown,
  expected: { key: string; error: string },
  what: string
): void => {
  const reply = result as { error?: unknown; key?: unknown } | null;
  assert(
    reply?.key === expected.key && reply?.error === expected.error,
    `${what}: expected { error: "${expected.error}", key: '${expected.key}' }, ` +
      `got ${show(result)}`
  );
};

const thread = async (who: AccountRef, peer: number, app = who.app): Promise<Dm[]> => {
  const { result } = await call<{ rows?: Dm[]; nextCursor?: unknown }>(DMS, 'get', who.citizenid, {
    app,
    account_id: who.id,
    peer_account_id: peer
  });
  assert(
    Array.isArray(result?.rows) && isNil(result.nextCursor),
    `dms:get on ${app} as ${who.id} with ${peer} answered ${show(result)}, not one page of rows`
  );
  const rows = result.rows as Dm[];
  for (const row of rows) {
    assert(!('citizenid' in row), `dms:get hands a peer the sender's citizenid: ${show(row)}`);
  }
  return rows;
};

const inbox = async (citizenid: string, app: string): Promise<Thread[]> => {
  const { result } = await call<Thread[]>(DMS, 'threads', citizenid, { app });
  assert(Array.isArray(result), `dms:threads on ${app} for ${citizenid} answered ${show(result)}`);
  for (const head of result) {
    assert(
      isNil(head.last) || !('citizenid' in (head.last as Dm)),
      `dms:threads hands a peer the sender's citizenid: ${show(head)}`
    );
  }
  return result;
};

/** The one thread in an inbox with `peer`, failing on none or on a duplicate. */
const threadWith = (threads: readonly Thread[], peer: number, what: string): Thread => {
  const found = threads.filter((head) => Number(head.peer_account_id) === peer);
  assert(found.length === 1, `${what}: ${found.length} threads with ${peer} in ${show(threads)}`);
  return found[0] as Thread;
};

const ids = (rows: readonly Dm[]): string => rows.map((row) => row.id).join(',');

/** Every DM between two accounts, either direction, as the table holds them. */
const rowsBetween = async (a: number, b: number): Promise<number> =>
  await db.count(
    'SELECT COUNT(*) FROM `mica_blabber_dms` ' +
      'WHERE (`from_account` = ? AND `to_account` = ?) OR (`from_account` = ? AND `to_account` = ?)',
    [a, b, b, a]
  );

const isDmPushFrom =
  (app: string, from: number) =>
  (envelope: PushEnvelope): boolean =>
    envelope.app === app &&
    envelope.event === 'dm' &&
    Number(envelope.payload?.peer_account_id) === from;

/** Wait for the `dm` push `from` caused, and check what it says and where it opens. */
const assertDmPush = async (
  to: string,
  from: AccountRef,
  text: string,
  signal: Signal
): Promise<void> => {
  const push = (await waitForPush(
    to,
    isDmPushFrom(from.app, from.id),
    5_000,
    signal,
    `the ${from.app} dm push from account ${from.id} to ${to}`
  )) as DmPush;
  assert(
    push.payload.handle === from.handle,
    `the dm push names handle ${show(push.payload.handle)}, not @${from.handle}`
  );
  const link = `${from.app}?dmHandle=${encodeURIComponent(from.handle)}`;
  assert(push.deepLink === link, `the dm push opens ${show(push.deepLink)}, not '${link}'`);
  assert(
    push.notify?.title === `@${from.handle}` && push.notify?.message === text,
    `the dm push's toast is ${show(push.notify)}, not @${from.handle} saying the text`
  );
  assert(push.persisted === true, `the dm push says persisted ${show(push.persisted)}`);
};

/** Drop every fixture row these citizens own, DMs and blocks first, accounts last. */
const removeFixtures = async (citizenids: readonly string[]): Promise<void> => {
  const marks = citizenids.map(() => '?').join(', ');
  const owned = `SELECT \`id\` FROM \`mica_accounts\` WHERE \`citizenid\` IN (${marks})`;
  // Each statement reads mica_accounts, never the table it deletes from (MySQL error 1093).
  await db.exec(
    `DELETE FROM \`mica_blabber_dms\` WHERE \`from_account\` IN (${owned}) ` +
      `OR \`to_account\` IN (${owned})`,
    [...citizenids, ...citizenids]
  );
  await db.exec(
    `DELETE FROM \`mica_account_blocks\` WHERE \`blocker_account_id\` IN (${owned}) ` +
      `OR \`blocked_account_id\` IN (${owned})`,
    [...citizenids, ...citizenids]
  );
  await db.exec(`DELETE FROM \`mica_accounts\` WHERE \`citizenid\` IN (${marks})`, [...citizenids]);
  await db.exec(`DELETE FROM \`mica_notifications\` WHERE \`citizenid\` IN (${marks})`, [
    ...citizenids
  ]);
};

export const dmsScenarios: Scenario[] = [
  {
    // MICA-390: a DM between two Blabber accounts lands as one active, unread row from one to
    // the other, its body sealed with the harness key and bound to both accounts (MICA-165).
    // The recipient's thread and inbox show it, with no citizenid anywhere (MICA-339); the
    // recipient is pushed `dm` on Blabber's channel naming the sender and opening the thread,
    // and the notification row it leaves keeps an empty body. The sender is pushed nothing.
    id: 'dms-send-lands-in-the-thread-and-pushes-the-recipient',
    mode: 'standalone',
    tickets: ['MICA-390', 'MICA-397'],
    run: async (signal) => {
      await schemaCreated(signal);
      const sender = unique('dm_from');
      const recipient = unique('dm_to');
      try {
        await seedPlayer(sender, 0);
        await seedPlayer(recipient, 0);
        const from = await claimAccount(sender, 'blabber');
        const to = await claimAccount(recipient, 'blabber');

        const text = `hello ${unique('dm')} ✓`;
        const sent = await sendOk(from, to, `  ${text}  `);
        await assertDmPush(recipient, from, text, signal);

        const row = await db.row(
          'SELECT `citizenid`, `from_account`, `to_account`, `body`, `status`, `read_at` ' +
            `FROM \`${TABLE}\` WHERE \`id\` = ?`,
          [sent.id]
        );
        assert(row, `send answered row ${sent.id}, which is not in ${TABLE}`);
        assert(
          row?.citizenid === sender &&
            Number(row?.from_account) === from.id &&
            Number(row?.to_account) === to.id &&
            row?.status === 'active' &&
            isNil(row?.read_at),
          `row ${sent.id} holds ${show({ ...row, body: undefined })}; expected an active, ` +
            `unread row owned by ${sender} from ${from.id} to ${to.id}`
        );
        const stored = String(row?.body);
        assert(
          sealedKid(stored) === HARNESS_KID,
          `the DM body is not sealed with '${HARNESS_KID}': ${stored.slice(0, 12)}…`
        );
        assert(!stored.includes('hello'), 'the DM plaintext is visible in the stored value');
        const opened = openSealed(stored, harnessKeys(), {
          table: TABLE,
          column: 'body',
          citizenid: sender,
          scope: [from.id, to.id]
        });
        assert(opened === text, `the stored body opened to ${show(opened)}, not the trimmed text`);
        const between = await rowsBetween(from.id, to.id);
        assert(between === 1, `${between} rows between the two accounts after one send`);

        const seen = await thread(to, from.id);
        assert(
          seen.length === 1 && seen[0]?.id === sent.id && seen[0]?.body === text,
          `the recipient's thread is ${show(seen)}, not the one DM ${sent.id} with its text`
        );
        const theirs = threadWith(await inbox(recipient, 'blabber'), from.id, "recipient's inbox");
        assert(
          theirs.handle === from.handle && theirs.last?.id === sent.id && theirs.unread === 1,
          `the recipient's inbox row is ${show(theirs)}; expected @${from.handle}, last ` +
            `${sent.id}, 1 unread`
        );
        const mine = threadWith(await inbox(sender, 'blabber'), to.id, "sender's inbox");
        assert(
          mine.handle === to.handle && mine.last?.id === sent.id && mine.unread === 0,
          `the sender's inbox row is ${show(mine)}; expected @${to.handle}, last ${sent.id}, ` +
            'nothing unread (their own message is not unread to them)'
        );

        // The recipient's push above is the positive twin of this.
        const echoed = (await pushes(sender)).filter((envelope) => envelope.event === 'dm');
        assert(echoed.length === 0, `the sender was pushed their own DM: ${show(echoed)}`);

        // Sealed to the phone it landed on (MICA-431), the empty body included: opened as it is
        // read, with the key the harness wrote.
        const notice = await eventually(
          async () => {
            const row = await db.row(
              'SELECT `citizenid`, `device_id`, `title`, `body`, `deep_link` ' +
                'FROM `mica_notifications` ' +
                "WHERE `citizenid` = ? AND `app` = 'blabber' AND `kind` = 'dm'",
              [recipient]
            );
            if (!row) return null;
            const open = (column: 'title' | 'body'): string =>
              openSealed(row[column], harnessKeys(), {
                table: 'mica_notifications',
                column,
                citizenid: String(row.citizenid),
                deviceId: (row.device_id as string | null) ?? null,
                scope: []
              });
            return { ...row, title: open('title'), body: open('body') } as Record<string, unknown>;
          },
          5_000,
          signal,
          "the recipient's stored dm notification"
        );
        assert(
          notice.title === `@${from.handle}` &&
            notice.body === '' &&
            notice.deep_link === `blabber?dmHandle=${from.handle}`,
          `the stored notification is ${show(notice)}; expected @${from.handle}, an empty body ` +
            '(the text stays sealed in the DM), and the thread link'
        );
      } finally {
        await removeFixtures([sender, recipient]);
      }
    }
  },
  {
    // MICA-393, MICA-390: the app is a parameter. The same two citizens holding an account on
    // Blabber and one on Glimpse have two threads, each only in its own app's inbox and
    // thread, each pushed on its own app's channel. Glimpse's thread is a real two-way thread
    // (a reply lands in it, newest first). An account in one app cannot send as or to the
    // other app: `send` refuses both, in the service's own words, and writes nothing.
    id: 'dms-glimpse-thread-is-its-own-beside-blabber',
    mode: 'standalone',
    tickets: ['MICA-393', 'MICA-390', 'MICA-397'],
    run: async (signal) => {
      await schemaCreated(signal);
      const ada = unique('dm_ada');
      const bo = unique('dm_bo');
      try {
        await seedPlayer(ada, 0);
        await seedPlayer(bo, 0);
        const adaBlabber = await claimAccount(ada, 'blabber');
        const boBlabber = await claimAccount(bo, 'blabber');
        const adaGlimpse = await claimAccount(ada, 'glimpse');
        const boGlimpse = await claimAccount(bo, 'glimpse');

        const onBlabber = `blabber ${unique('dm')}`;
        const blab = await sendOk(adaBlabber, boBlabber, onBlabber);
        await assertDmPush(bo, adaBlabber, onBlabber, signal);
        const onGlimpse = `glimpse ${unique('dm')}`;
        const glimpse = await sendOk(adaGlimpse, boGlimpse, onGlimpse);
        await assertDmPush(bo, adaGlimpse, onGlimpse, signal);

        const apps = await db.row(
          'SELECT f.`app` AS `from_app`, t.`app` AS `to_app` FROM `mica_blabber_dms` d ' +
            'JOIN `mica_accounts` f ON f.`id` = d.`from_account` ' +
            'JOIN `mica_accounts` t ON t.`id` = d.`to_account` WHERE d.`id` = ?',
          [glimpse.id]
        );
        assert(
          apps?.from_app === 'glimpse' && apps?.to_app === 'glimpse',
          `the Glimpse DM ${glimpse.id} runs between accounts in ${show(apps)}`
        );

        const glimpseInbox = await inbox(bo, 'glimpse');
        assert(
          glimpseInbox.length === 1,
          `Bo's Glimpse inbox has ${glimpseInbox.length} threads, not 1: ${show(glimpseInbox)}`
        );
        const g = threadWith(glimpseInbox, adaGlimpse.id, "Bo's Glimpse inbox");
        assert(
          g.handle === adaGlimpse.handle && g.last?.id === glimpse.id && g.unread === 1,
          `Bo's Glimpse thread is ${show(g)}; expected @${adaGlimpse.handle}, last ` +
            `${glimpse.id}, 1 unread`
        );
        const blabberInbox = await inbox(bo, 'blabber');
        assert(
          blabberInbox.length === 1,
          `Bo's Blabber inbox has ${blabberInbox.length} threads, not 1: ${show(blabberInbox)}`
        );
        const b = threadWith(blabberInbox, adaBlabber.id, "Bo's Blabber inbox");
        assert(
          b.last?.id === blab.id && b.unread === 1,
          `Bo's Blabber thread is ${show(b)}; expected last ${blab.id}, 1 unread`
        );

        // A reply makes it a thread, union of both directions, newest first.
        const reply = await sendOk(boGlimpse, adaGlimpse, `re: ${onGlimpse}`);
        await assertDmPush(ada, boGlimpse, `re: ${onGlimpse}`, signal);
        const both = await thread(adaGlimpse, boGlimpse.id);
        assert(
          ids(both) === `${reply.id},${glimpse.id}`,
          `Ada's Glimpse thread is [${ids(both)}], not [${reply.id},${glimpse.id}]`
        );
        const blabberThread = await thread(adaBlabber, boBlabber.id);
        assert(
          ids(blabberThread) === String(blab.id),
          `Ada's Blabber thread is [${ids(blabberThread)}], not just [${blab.id}]`
        );
        // Asked as a Glimpse account about the other's Blabber account: nothing between them.
        const across = await thread(boGlimpse, adaBlabber.id);
        assert(across.length === 0, `a Glimpse thread with a Blabber account holds ${ids(across)}`);

        // A Glimpse account is not Ada's to send from on Blabber, and Bo's Blabber account is
        // not someone a Glimpse DM can reach.
        const asOther = await send(adaGlimpse, boBlabber.id, 'cross', 'blabber');
        assertRefused(
          asOther.result,
          REFUSED.notYoursToSend,
          'a Blabber send from a Glimpse account'
        );
        const toOther = await send(adaGlimpse, boBlabber.id, 'cross', 'glimpse');
        assertRefused(toOther.result, REFUSED.blocked, 'a Glimpse send to a Blabber account');
        const written = await rowsBetween(adaGlimpse.id, boBlabber.id);
        assert(written === 0, `the refused cross-app sends wrote ${written} rows`);
      } finally {
        await removeFixtures([ada, bo]);
      }
    }
  },
  {
    // MICA-390: what `send` holds every app to, each refused in the service's own words and
    // none writing a row — an app with no DM policy, an empty body, messaging yourself, sending
    // as an account that is not yours, and a peer that is no account, answered exactly as a
    // block is (MICA-255). A block by the recipient refuses both directions and hides none of
    // the history; lifting it lets the next send through, the positive twin of the refusal.
    id: 'dms-send-refusals-write-nothing-and-a-block-cuts-both-ways',
    mode: 'standalone',
    tickets: ['MICA-390', 'MICA-397'],
    run: async (signal) => {
      await schemaCreated(signal);
      const ada = unique('dm_refuse_a');
      const bo = unique('dm_refuse_b');
      try {
        await seedPlayer(ada, 0);
        await seedPlayer(bo, 0);
        const a = await claimAccount(ada, 'blabber');
        const b = await claimAccount(bo, 'blabber');

        const noPolicy = await send(a, b.id, 'hello', 'itx_nodms');
        assertRefused(noPolicy.result, REFUSED.noPolicy, 'a send in an app with no DM policy');
        const empty = await send(a, b.id, '   ');
        assertRefused(empty.result, REFUSED.emptyMessage, 'a whitespace-only send');
        const self = await send(a, a.id, 'me');
        assertRefused(self.result, REFUSED.selfMessage, 'a send to your own account');
        const asAda = await invoke(DMS, 'send', bo, {
          app: 'blabber',
          account_id: a.id,
          peer_account_id: b.id,
          body: 'not mine'
        });
        assertRefused(asAda.result, REFUSED.notYoursToSend, "Bo sending as Ada's account");
        const readAsAda = await invoke(DMS, 'get', bo, {
          app: 'blabber',
          account_id: a.id,
          peer_account_id: b.id
        });
        assertRefused(readAsAda.result, REFUSED.notYours, "Bo reading as Ada's account");

        const highest = await db.count('SELECT COALESCE(MAX(`id`), 0) FROM `mica_accounts`');
        const nobody = highest + 1_000;
        const ghost = await send(a, nobody, 'anyone there?');
        assertRefused(ghost.result, REFUSED.blocked, `a send to account ${nobody}, which is none`);
        const fromAda = await db.count(
          'SELECT COUNT(*) FROM `mica_blabber_dms` WHERE `from_account` IN (?, ?)',
          [a.id, b.id]
        );
        assert(fromAda === 0, `the refused sends left ${fromAda} rows`);

        const before = await sendOk(a, b, 'before the block');
        const { result: blocked } = await call<boolean>(ACCOUNTS, 'block', bo, {
          app: 'blabber',
          blocker_account_id: b.id,
          blocked_account_id: a.id
        });
        assert(blocked === true, `accounts:block answered ${show(blocked)}`);
        const held = await db.count(
          'SELECT COUNT(*) FROM `mica_account_blocks` ' +
            'WHERE `blocker_account_id` = ? AND `blocked_account_id` = ?',
          [b.id, a.id]
        );
        assert(held === 1, `${held} block rows from ${b.id} on ${a.id} after accounts:block`);

        const toBlocker = await send(a, b.id, 'after the block');
        assertRefused(toBlocker.result, REFUSED.blocked, 'a send to the account that blocked you');
        const fromBlocker = await send(b, a.id, 'blocker writes');
        assertRefused(fromBlocker.result, REFUSED.blocked, 'a send to an account you blocked');
        const kept = await rowsBetween(a.id, b.id);
        assert(kept === 1, `${kept} rows between the two after the refused sends, not 1`);
        // History stays: a block refuses a new send, it does not hide the thread.
        for (const [side, peer] of [
          [a, b],
          [b, a]
        ] as const) {
          const history = await thread(side, peer.id);
          assert(
            ids(history) === String(before.id),
            `account ${side.id}'s thread across the block is [${ids(history)}], ` +
              `not [${before.id}]`
          );
        }

        const { result: lifted } = await call<boolean>(ACCOUNTS, 'unblock', bo, {
          app: 'blabber',
          blocker_account_id: b.id,
          blocked_account_id: a.id
        });
        assert(lifted === true, `accounts:unblock answered ${show(lifted)}`);
        const after = await sendOk(a, b, 'after the unblock');
        const total = await rowsBetween(a.id, b.id);
        assert(
          total === 2 && after.id > before.id,
          `${total} rows between the two after the unblocked send, not 2`
        );
      } finally {
        await removeFixtures([ada, bo]);
      }
    }
  },
  {
    // MICA-390: `read` clears exactly what was sent to the account that asks. The inbox counts
    // unread per correspondent; the other end reading its own side, or asking as an account
    // not its own, moves nothing on this side. A second read finds nothing left and says so,
    // and a new message after it is unread again while the read ones stay read.
    id: 'dms-read-clears-only-the-readers-unread-count',
    mode: 'standalone',
    tickets: ['MICA-390', 'MICA-397'],
    run: async (signal) => {
      await schemaCreated(signal);
      const ada = unique('dm_read_a');
      const bo = unique('dm_read_b');
      try {
        await seedPlayer(ada, 0);
        await seedPlayer(bo, 0);
        const a = await claimAccount(ada, 'blabber');
        const b = await claimAccount(bo, 'blabber');

        const toBo: Dm[] = [];
        for (const n of [1, 2, 3]) toBo.push(await sendOk(a, b, `to bo ${n}`));
        const toAda = await sendOk(b, a, 'to ada');

        const unreadTo = async (account: number): Promise<number> =>
          await db.count(
            'SELECT COUNT(*) FROM `mica_blabber_dms` WHERE `to_account` = ? AND `read_at` IS NULL',
            [account]
          );
        const boHead = async (): Promise<Thread> =>
          threadWith(await inbox(bo, 'blabber'), a.id, "Bo's inbox");

        const first = await boHead();
        assert(
          first.unread === 3 && first.last?.id === toAda.id,
          `Bo's inbox row is ${show(first)}; expected 3 unread and the last message ${toAda.id}`
        );
        const adaFirst = threadWith(await inbox(ada, 'blabber'), b.id, "Ada's inbox");
        assert(adaFirst.unread === 1, `Ada's inbox counts ${adaFirst.unread} unread, not 1`);

        // Ada reads her side: her one unread goes, Bo's three do not move.
        const { result: adaRead } = await call<boolean>(DMS, 'read', ada, {
          app: 'blabber',
          account_id: a.id,
          peer_account_id: b.id
        });
        assert(adaRead === true, `Ada's read of one unread message answered ${show(adaRead)}`);
        assert((await unreadTo(a.id)) === 0, "Ada's read left her message unread");
        assert(
          (await unreadTo(b.id)) === 3,
          `Ada reading her own side changed Bo's unread to ${await unreadTo(b.id)}`
        );
        const asBo = await invoke(DMS, 'read', ada, {
          app: 'blabber',
          account_id: b.id,
          peer_account_id: a.id
        });
        assertRefused(asBo.result, REFUSED.notYours, "Ada marking Bo's account read");
        assert(
          (await unreadTo(b.id)) === 3,
          `a refused read as Bo's account changed Bo's unread to ${await unreadTo(b.id)}`
        );

        const { result: boRead } = await call<boolean>(DMS, 'read', bo, {
          app: 'blabber',
          account_id: b.id,
          peer_account_id: a.id
        });
        assert(boRead === true, `Bo's read of three unread answered ${show(boRead)}`);
        const marked = await db.count(
          'SELECT COUNT(*) FROM `mica_blabber_dms` ' +
            `WHERE \`id\` IN (${toBo.map(() => '?').join(', ')}) AND \`read_at\` IS NOT NULL`,
          toBo.map((dm) => dm.id)
        );
        assert(marked === 3, `${marked} of Bo's three messages are marked read, not 3`);
        const cleared = await boHead();
        assert(cleared.unread === 0, `Bo's inbox still counts ${cleared.unread} unread`);
        const { result: again } = await call<boolean>(DMS, 'read', bo, {
          app: 'blabber',
          account_id: b.id,
          peer_account_id: a.id
        });
        assert(again === false, `a second read with nothing unread answered ${show(again)}`);

        const fresh = await sendOk(a, b, 'one more');
        const next = await boHead();
        assert(
          next.unread === 1 && next.last?.id === fresh.id,
          `after one more message Bo's inbox row is ${show(next)}; expected 1 unread, last ` +
            `${fresh.id}`
        );
        assert(
          (await unreadTo(b.id)) === 1,
          `the read messages became unread again: ${await unreadTo(b.id)} unread to Bo`
        );
      } finally {
        await removeFixtures([ada, bo]);
      }
    }
  }
];
