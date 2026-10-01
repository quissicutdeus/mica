// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { Scenario } from '../runner';
import { requireTap } from '../lib/console';
import { db } from '../lib/db';
import {
  HARNESS_KID,
  assert,
  callExport,
  expectOk,
  harnessKeys,
  runCommand,
  seedCitizen,
  unique
} from '../lib/mica';
import { openSealed, sealedKid } from '../lib/sealed';
import { eventually, sleep } from '../lib/wait';

/**
 * Content encryption at rest, end to end (MICA-165): bodies that arrive through micaOS's public
 * surfaces land sealed with the harness's key, open again to what was sent, and the console's
 * `micacrypt` seals what was stored before and prints the steps for a new key without writing
 * one or showing it.
 */

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A mail row's body, opened with the harness key — or a throw saying why it would not. */
const openMail = async (
  id: number
): Promise<{ stored: string; text: string; citizenid: string }> => {
  const row = await db.row('SELECT `citizenid`, `content` FROM `mica_mail` WHERE `id` = ?', [id]);
  if (!row) throw new Error(`mica_mail row ${id} is not there`);
  const stored = String(row.content);
  if (sealedKid(stored) !== HARNESS_KID) {
    throw new Error(
      `mica_mail row ${id} is not sealed with '${HARNESS_KID}': ${stored.slice(0, 12)}…`
    );
  }
  const citizenid = String(row.citizenid);
  const text = openSealed(stored, harnessKeys(), {
    table: 'mica_mail',
    column: 'content',
    citizenid,
    scope: []
  });
  return { stored, text, citizenid };
};

/** The `[micacrypt] <table>.<column>: …` line out of a status or backfill run. */
const columnLine = (lines: string[], column: string): string => {
  const line = lines.find((l) => l.startsWith(`[micacrypt] ${column}:`));
  if (!line) throw new Error(`micacrypt printed no line for ${column}`);
  return line;
};

const numberIn = (line: string, pattern: RegExp, what: string): number => {
  const match = pattern.exec(line);
  if (!match) throw new Error(`no ${what} in '${line}'`);
  return Number(match[1]);
};

/** Run `micacrypt <args>` and return what it printed from its first line on. */
const micacrypt = async (
  args: string,
  header: RegExp,
  signal: { readonly aborted: boolean }
): Promise<string[]> => {
  const tap = requireTap();
  const mark = tap.mark();
  await runCommand(`micacrypt ${args}`);
  await tap.waitFor(mark, header, 20_000, signal, `micacrypt ${args}'s first line`);
  // The rest are printed in the same loop; a moment covers a listener that delivers late.
  await sleep(1_000);
  const lines = tap.since(mark).filter((l) => l.startsWith('[micacrypt]'));
  const busy = lines.find((l) => /already running|failed part-way|refused/.test(l));
  if (busy) throw new Error(`micacrypt ${args}: ${busy}`);
  return lines;
};

export const cryptoScenarios: Scenario[] = [
  {
    // MICA-165, MICA-223: a SendMessage body is sealed with the harness key, bound to its row
    // (it opens with this row's citizenid and conversation, and only those), and the recipient
    // is offline so the export says it was not delivered live.
    id: 'crypto-send-message-body-sealed-at-rest',
    tickets: ['MICA-165', 'MICA-223'],
    run: async () => {
      const recipient = await seedCitizen('msg_to');
      const body = `integration ${unique('body')} — sealed? ✓`;
      const sent = await expectOk<{
        conversationId: number;
        messageId: number;
        delivered: boolean;
      }>('SendMessage', recipient.citizenid, { from: { name: 'IT Dispatch' }, body });
      assert(sent.delivered === false, 'an offline recipient was reported as delivered live');

      const row = await db.row(
        'SELECT `citizenid`, `conversation_id`, `message`, `external_sender` FROM `mica_messages` WHERE `id` = ?',
        [sent.messageId]
      );
      if (!row) throw new Error(`mica_messages row ${sent.messageId} is not there`);
      assert(
        Number(row.conversation_id) === sent.conversationId,
        'the row is not in the conversation SendMessage named'
      );
      assert(
        row.external_sender === 'IT Dispatch',
        `external_sender is ${String(row.external_sender)}`
      );
      const stored = String(row.message);
      assert(sealedKid(stored) === HARNESS_KID, `the body is not sealed with '${HARNESS_KID}'`);
      assert(!stored.includes('integration'), 'the plaintext is visible in the stored value');
      const keys = harnessKeys();
      const context = {
        table: 'mica_messages',
        column: 'message',
        citizenid: String(row.citizenid),
        scope: [row.conversation_id as number]
      };
      assert(openSealed(stored, keys, context) === body, 'the body opened to something else');

      let movedOpened = true;
      try {
        openSealed(stored, keys, { ...context, scope: [sent.conversationId + 1] });
      } catch {
        movedOpened = false;
      }
      assert(!movedOpened, 'the body opened under another conversation: the AAD binds nothing');

      const participants = await db.count(
        'SELECT COUNT(*) FROM `mica_messages_participants` WHERE `conversation_id` = ? AND `citizenid` = ?',
        [sent.conversationId, recipient.citizenid]
      );
      assert(participants === 1, `the recipient is in the thread ${participants} times, not once`);
    }
  },
  {
    // MICA-165, MICA-222: the SendSystemEmail export hands back the mail as sent while the row
    // holds it sealed, and the recipient's notification is persisted for when they come back.
    id: 'crypto-send-system-email-body-sealed-at-rest',
    tickets: ['MICA-165', 'MICA-222'],
    run: async (signal) => {
      const recipient = await seedCitizen('mail_to');
      const content = `integration ${unique('mail')} body`;
      const mail = await callExport<{ id?: number; content?: string } | null>(
        'SendSystemEmail',
        recipient.citizenid,
        { sender: 'IT Bank', subject: 'Statement', content }
      );
      if (!mail || typeof mail.id !== 'number') {
        throw new Error(`SendSystemEmail answered ${JSON.stringify(mail)}`);
      }
      assert(mail.content === content, 'the returned mail does not carry the plaintext body');
      const opened = await openMail(mail.id);
      assert(opened.citizenid === recipient.citizenid, 'the mail landed in another mailbox');
      assert(opened.text === content, 'the stored body opened to something else');
      await eventually(
        async () =>
          (await db.count(
            "SELECT COUNT(*) FROM `mica_notifications` WHERE `citizenid` = ? AND `app` = 'mail'",
            [recipient.citizenid]
          )) || null,
        5_000,
        signal,
        'a persisted mail notification'
      );
    }
  },
  {
    // MICA-222, MICA-165: qb-phone's server-only `sendNewMailToOffline`, fired by another
    // server resource with qb's payload shape, lands as sealed mail for that citizenid.
    id: 'crypto-qbphone-send-new-mail-to-offline-sealed',
    tickets: ['MICA-222', 'MICA-165'],
    run: async (signal) => {
      const recipient = await seedCitizen('qbmail_to');
      const subject = unique('qbsubject');
      const message = `qb body ${subject}`;
      emit('qb-phone:server:sendNewMailToOffline', recipient.citizenid, {
        sender: 'Los Santos Customs',
        subject,
        message,
        button: {}
      });
      const id = await eventually(
        async () => {
          const row = await db.row(
            'SELECT `id` FROM `mica_mail` WHERE `citizenid` = ? AND `subject` = ?',
            [recipient.citizenid, subject]
          );
          return row ? Number(row.id) : null;
        },
        5_000,
        signal,
        'the qb-phone mail row'
      );
      assert((await openMail(id)).text === message, 'the qb-phone body opened to something else');
    }
  },
  {
    // MICA-165: `micacrypt status` counts a plaintext row stored before a key; `backfill
    // --apply` seals it in place with `updated_at` pinned; a second backfill seals nothing and
    // leaves the stored value byte for byte as it was.
    id: 'crypto-micacrypt-backfill-seals-plaintext-once',
    tickets: ['MICA-165'],
    timeoutMs: 60_000,
    run: async (signal) => {
      const owner = unique('legacy');
      const content = `legacy plaintext ${owner}`;
      const id = await db.insert(
        'INSERT INTO `mica_mail` (`citizenid`, `sender`, `subject`, `content`, `created_at`, `updated_at`) ' +
          "VALUES (?, 'IT', 'legacy', ?, '2026-01-02 03:04:05', '2026-01-02 03:04:05')",
        [owner, content]
      );
      const updatedAt = async () =>
        Number(
          await db.count('SELECT UNIX_TIMESTAMP(`updated_at`) FROM `mica_mail` WHERE `id` = ?', [
            id
          ])
        );
      const pinned = await updatedAt();

      const status = await micacrypt('status', /^\[micacrypt\] sealing with key /, signal);
      assert(
        status[0].includes(`'${HARNESS_KID}'`),
        `status does not seal with '${HARNESS_KID}': ${status[0]}`
      );
      const plaintext = numberIn(
        columnLine(status, 'mica_mail.content'),
        /plaintext (\d+)/,
        'plaintext count'
      );
      assert(plaintext >= 1, `status counts ${plaintext} plaintext mail bodies, not at least 1`);
      assert(
        (await db.row('SELECT `content` FROM `mica_mail` WHERE `id` = ?', [id]))?.content ===
          content,
        'micacrypt status changed a row'
      );

      const first = await micacrypt(
        'backfill --apply',
        /^\[micacrypt\] backfill with key /,
        signal
      );
      const firstLine = columnLine(first, 'mica_mail.content');
      assert(
        numberIn(firstLine, /— sealed (\d+) /, 'sealed count') >= 1,
        `first run: ${firstLine}`
      );
      assert(numberIn(firstLine, /unreadable (\d+)/, 'unreadable count') === 0, firstLine);
      const opened = await openMail(id);
      assert(opened.text === content, 'the backfilled body opened to something else');
      assert((await updatedAt()) === pinned, 'the backfill moved updated_at');

      const second = await micacrypt(
        'backfill --apply',
        /^\[micacrypt\] backfill with key /,
        signal
      );
      const secondLine = columnLine(second, 'mica_mail.content');
      assert(
        numberIn(secondLine, /— sealed (\d+) /, 'sealed count') === 0,
        `second run: ${secondLine}`
      );
      assert((await openMail(id)).stored === opened.stored, 'the second backfill rewrote the row');
      assert((await updatedAt()) === pinned, 'the second backfill moved updated_at');
    }
  },
  {
    // MICA-303: `micacrypt keygen` writes nothing and prints no key. FXServer lets a resource
    // write only into its own folder (MICA-302 measured it here), and micaOS's own folder is the
    // one place a key must not live, so keygen prints the steps for the owner's shell instead:
    // the openssl line and the `mica-keys` resource the key belongs in.
    //
    // The old form, a path, is tried in every directory keygen used to be pointed at — beside
    // the live key, micaOS's own folder, the temp directory — and must be refused with nothing
    // appearing there. What this resource can see is limited by the same sandbox, so a path it
    // may not look at is reported as not observable rather than counted either way; the paths
    // inside resource folders are the ones checked for real.
    id: 'crypto-micacrypt-keygen-prints-steps-and-writes-nothing',
    tickets: ['MICA-165', 'MICA-303'],
    run: async (signal) => {
      const tap = requireTap();
      const first = tap.mark();
      const keyFile = GetConvar('mica_content_key_file', '').trim();
      const cut = keyFile.lastIndexOf('/');
      const micaRoot = (GetResourcePath('mica') || '').replace(/\/+$/, '');
      const dirs = [...new Set([cut > 0 ? keyFile.slice(0, cut) : '', micaRoot, tmpdir()])].filter(
        Boolean
      );
      const tried = dirs.map((dir) => `${dir}/${unique('keygen')}.key`);

      for (const path of tried) {
        const mark = tap.mark();
        await runCommand(`micacrypt keygen ${path}`);
        await tap.waitFor(
          mark,
          /^\[micacrypt\] keygen refused: .*keygen takes no path: it writes nothing/,
          10_000,
          signal,
          `keygen's refusal of the path ${path}`
        );
      }

      const kid = `itg-${Date.now().toString(36).slice(-8)}`;
      const mark = tap.mark();
      await runCommand(`micacrypt keygen ${kid}`);
      await tap.waitFor(mark, /^\[micacrypt\] to rotate instead/, 10_000, signal, "keygen's steps");
      await sleep(300);
      const lines = tap.since(mark).filter((line) => line.startsWith('[micacrypt]'));
      const said = lines.join('\n');
      const step = (pattern: RegExp, what: string): string => {
        const found = lines.find((line) => pattern.test(line));
        if (!found) throw new Error(`keygen printed no ${what}: ${lines.join(' | ')}`);
        return found;
      };
      step(
        new RegExp(
          `\\(umask 077; set -C; printf '%s %s\\\\n' "${escape(kid)}" ` +
            `"\\$\\(openssl rand -base64 32\\)" > ".*/mica-keys/mica-content\\.key"\\)$`
        ),
        'openssl line for the new key'
      );
      step(/^\[micacrypt\] {6}mkdir -p ".*\/resources\/\[local\]\/mica-keys"$/, 'mica-keys folder');
      step(/^\[micacrypt\] {6}fx_version 'cerulean'$/, 'fxmanifest fx_version line');
      step(/^\[micacrypt\] {6}game 'common'$/, 'fxmanifest game line');
      const setLine = step(
        /^\[micacrypt\] {6}set mica_content_key_file ".*\/mica-keys\/mica-content\.key"$/,
        'server.cfg line'
      );
      step(/micacrypt backfill --apply/, 'backfill step');
      const suggested = /"(.*)"$/.exec(setLine)?.[1] ?? '';

      // Nothing key-shaped anywhere on the console since the first command: base64 of 32 bytes
      // is 43 characters and a '='.
      const leaked = tap.since(first).find((line) => /[A-Za-z0-9+/]{43}=/.test(line));
      assert(leaked === undefined, `keygen printed something shaped like a key: ${leaked}`);

      // And no file: not where a path was given, not where the steps say the key goes. The
      // sandbox decides which of those this resource may look at — the first hoth run of this
      // scenario had `existsSync` throw "Access to this API has been restricted" for the
      // suggested `[local]/mica-keys` path, a folder that is no resource there. A refused look
      // is neither a pass nor a fail: it is said, and only the paths seen count. At least one
      // must be seen, or the check never ran.
      const seen: string[] = [];
      const hidden: string[] = [];
      for (const path of [...tried, suggested]) {
        let there: boolean;
        try {
          there = existsSync(path);
        } catch {
          hidden.push(path);
          continue;
        }
        assert(!there, `keygen left a file at ${path}`);
        seen.push(path);
      }
      assert(
        seen.length > 0,
        `no path keygen could have written is visible to this resource: ${hidden.join(', ')}`
      );

      // The refusal of an id the loaded keyring already holds stays, with no steps after it.
      const dup = tap.mark();
      await runCommand(`micacrypt keygen ${HARNESS_KID}`);
      await tap.waitFor(
        dup,
        new RegExp(`^\\[micacrypt\\] keygen refused: the key id '${HARNESS_KID}' is already`),
        10_000,
        signal,
        'the refusal of a loaded key id'
      );
      await sleep(300);
      assert(
        !tap.since(dup).some((line) => line.includes('openssl')),
        'keygen printed steps for a key id the keyring already has'
      );

      // For MICA-303's docs: what keygen prints on a real FXServer, paths resolved.
      console.log(`[mica-integration] keygen said: ${said.split('\n').length} lines; ${setLine}`);
      console.log(
        `[mica-integration] keygen wrote nothing at ${seen.join(', ')}` +
          (hidden.length > 0 ? `; not observable here (sandbox): ${hidden.join(', ')}` : '')
      );
    }
  }
];
