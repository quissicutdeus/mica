// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs';
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
import { openSealed, parseKeyFile, sealedKid } from '../lib/sealed';
import { eventually, sleep } from '../lib/wait';

/**
 * Content encryption at rest, end to end (MICA-165): bodies that arrive through micaOS's public
 * surfaces land sealed with the harness's key, open again to what was sent, and the console's
 * `micacrypt` seals what was stored before and writes new keys without ever overwriting one.
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
    // MICA-165: `micacrypt keygen` writes a key file only its owner can read, refuses to
    // overwrite one, and refuses an id the loaded keyring already has.
    //
    // FXServer's filesystem sandbox decides where micaOS may write, so the directory is found by
    // asking keygen itself: the key file's own directory first, then the temp directory, and the
    // first where it reports a write is used. Every path tried and keygen's answer for it is
    // printed as one `[mica-integration] keygen:` line, pass or fail, because where FXServer
    // lets a resource write a key file is what MICA-165's docs have to say.
    //
    // The mode is checked here, with this resource's own stat, and nowhere else: keygen's
    // "(mode 600)" is fixed text, and micaOS's exposure warning is silent when its own stat
    // fails. A file this resource cannot stat is a FAIL that says so, never a pass.
    id: 'crypto-micacrypt-keygen-writes-0600-and-never-overwrites',
    tickets: ['MICA-165'],
    run: async (signal) => {
      const tap = requireTap();
      const keyFile = GetConvar('mica_content_key_file', '').trim();
      const cut = keyFile.lastIndexOf('/');
      const dirs = [...new Set([cut > 0 ? keyFile.slice(0, cut) : '', tmpdir()])].filter(Boolean);
      const kid = `itg-${Date.now().toString(36).slice(-8)}`;
      const answer = (path: string): RegExp =>
        new RegExp(
          `^\\[micacrypt\\] (wrote a new key '${escape(kid)}' to ${escape(path)} |keygen refused: )`
        );
      const written: string[] = [];
      // `<path>: <what keygen said>` per attempt, then what this resource's own stat found.
      const trail: string[] = [];
      const report = (): string => trail.join('; ');
      try {
        let path: string | null = null;
        let dir = '';
        for (const candidateDir of dirs) {
          const candidate = `${candidateDir}/${unique('keygen')}.key`;
          const mark = tap.mark();
          await runCommand(`micacrypt keygen ${candidate} ${kid}`);
          let said: string;
          try {
            said = await tap.waitFor(mark, answer(candidate), 10_000, signal, "keygen's answer");
          } catch (error) {
            trail.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
            throw new Error(`keygen did not answer: ${report()}`, { cause: error });
          }
          if (!said.includes('wrote a new key')) {
            trail.push(`${candidate}: ${said.replace(/^\[micacrypt\] /, '')}`);
            continue;
          }
          trail.push(`${candidate}: wrote`);
          path = candidate;
          dir = candidateDir;
          written.push(candidate);
          break;
        }
        if (path === null) throw new Error(`keygen wrote nowhere: ${report()}`);

        // The real check, with this resource's own eyes. Unverifiable is a failure.
        let mode: number;
        let before: string;
        try {
          mode = statSync(path).mode & 0o777;
          before = readFileSync(path, 'utf8');
        } catch (error) {
          trail.push(
            `this resource could not read it back (${error instanceof Error ? error.message : String(error)})`
          );
          throw new Error(`the key file's mode is unverified: ${report()}`, { cause: error });
        }
        trail.push(`mode ${mode.toString(8)}`);
        assert(mode === 0o600, `the key file is not mode 600: ${report()}`);
        assert(
          parseKeyFile(before).has(kid),
          `the key file does not hold the new key: ${report()}`
        );

        let mark = tap.mark();
        await runCommand(`micacrypt keygen ${path} ${kid}`);
        await tap.waitFor(
          mark,
          new RegExp(`^\\[micacrypt\\] keygen refused: ${escape(path)} already exists`),
          10_000,
          signal,
          'the refusal to overwrite'
        );
        assert(readFileSync(path, 'utf8') === before, 'keygen overwrote an existing key file');

        const other = `${dir}/${unique('keygen_dup')}.key`;
        mark = tap.mark();
        await runCommand(`micacrypt keygen ${other} ${HARNESS_KID}`);
        await tap.waitFor(
          mark,
          new RegExp(`^\\[micacrypt\\] keygen refused: the key id '${HARNESS_KID}' is already`),
          10_000,
          signal,
          'the refusal of a loaded key id'
        );
        await sleep(300);
        assert(
          !tap.since(mark).some((line) => line.includes('wrote a new key')),
          'keygen wrote a file for a key id the keyring already has'
        );
      } finally {
        // Pass or fail: where FXServer let micaOS write a key file, for MICA-165's docs.
        console.log(`[mica-integration] keygen: ${report() || 'nothing tried'}`);
        for (const file of written) {
          try {
            if (existsSync(file)) unlinkSync(file);
          } catch {
            // Left behind in a throwaway server; not this scenario's verdict.
          }
        }
      }
    }
  }
];
