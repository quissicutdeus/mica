// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Scenario } from '../runner';
import { db } from '../lib/db';
import {
  HARNESS_KID,
  assert,
  callExport,
  expectOk,
  expectRefusal,
  freeNumber,
  harnessKeys,
  seedCitizen,
  unique,
  type Outcome
} from '../lib/mica';
import { openSealed, sealedKid } from '../lib/sealed';
import { eventually } from '../lib/wait';

/**
 * micaOS's public server exports (`server/lib/publicApi.ts`), called from another resource as a
 * job or dispatch script would, against characters who are not connected — the case every
 * citizenid-keyed export exists for.
 */

/** A source no player holds. Nobody connects to the harness, so any positive id will do. */
const ABSENT_SOURCE = 4242;

export const exportScenarios: Scenario[] = [
  {
    // MICA-223, MICA-232: the directory exports answer for an offline character from micaOS's
    // own number table, both ways, and say `offline` rather than `unknown_player` for a number a
    // character holds while away.
    id: 'exports-directory-lookups-for-an-offline-character',
    mode: 'standalone',
    tickets: ['MICA-223', 'MICA-232'],
    run: async () => {
      const who = await seedCitizen('dir');
      assert((await expectOk<number>('GetApiVersion')) === 1, 'GetApiVersion is not 1');
      assert(
        (await expectOk<string>('GetPhoneNumber', who.citizenid)) === who.number,
        'GetPhoneNumber answered another number'
      );
      assert(
        (await expectOk<string>('GetCitizenId', who.number)) === who.citizenid,
        'GetCitizenId answered another citizenid'
      );
      await expectRefusal('offline', 'GetSourceFromNumber', who.number);
      await expectRefusal('unknown_player', 'GetSourceFromNumber', await freeNumber());
      await expectRefusal('unknown_player', 'GetPhoneNumber', unique('nobody'));
      const emergency = await expectOk<string>('GetEmergencyNumber');
      assert(typeof emergency === 'string' && emergency.length > 0, 'no emergency number');
      const link = await expectOk<string>('BuildDeepLink', 'mail', { mailId: 7 });
      assert(typeof link === 'string' && link.startsWith('mail'), `BuildDeepLink gave ${link}`);
    }
  },
  {
    // MICA-223: SendMessage refuses what it must — an unknown citizen, a sender with neither
    // name nor number, an empty body, and above all a `from.number` a character holds, which
    // would put words in a player's mouth.
    id: 'exports-send-message-refusals',
    mode: 'standalone',
    tickets: ['MICA-223'],
    run: async () => {
      const to = await seedCitizen('refuse_to');
      const player = await seedCitizen('refuse_held');
      await expectRefusal('unknown_player', 'SendMessage', unique('ghost'), {
        from: { name: 'IT' },
        body: 'hi'
      });
      await expectRefusal('invalid_args', 'SendMessage', to.citizenid, { from: {}, body: 'hi' });
      await expectRefusal('invalid_args', 'SendMessage', to.citizenid, {
        from: { name: 'IT' },
        body: '   '
      });
      await expectRefusal('number_in_use', 'SendMessage', to.citizenid, {
        from: { number: player.number },
        body: 'impersonation'
      });
      const written = await db.count('SELECT COUNT(*) FROM `mica_messages` WHERE `citizenid` = ?', [
        to.citizenid
      ]);
      assert(written === 0, `a refused SendMessage still wrote ${written} row(s)`);
    }
  },
  {
    // MICA-226, MICA-275 (server half): a resource owns a line, texts from it into a thread that
    // is sealed like any other, and releases it; the registry refuses what it must.
    id: 'exports-registered-line-sends-and-releases',
    mode: 'standalone',
    tickets: ['MICA-226', 'MICA-275', 'MICA-223'],
    run: async () => {
      const to = await seedCitizen('line_to');
      const line = await freeNumber();
      const onCall = () => ({ action: 'reject' });
      await expectRefusal('invalid_args', 'RegisterNumber', 'not a number', { onCall });
      await expectRefusal('invalid_args', 'RegisterNumber', line, {});
      await expectRefusal('invalid_args', 'RegisterNumber', line, { onCall, job: 'Not A Job' });
      await expectOk('RegisterNumber', line, { onCall, label: 'IT Line', blockable: false });
      try {
        // A number owned by a line has no character behind it.
        await expectRefusal('unknown_player', 'GetSourceFromNumber', line);
        const body = `from the line ${unique('linebody')}`;
        const sent = await expectOk<{ conversationId: number; messageId: number }>(
          'SendMessage',
          to.citizenid,
          { from: { number: line }, body }
        );
        const row = await db.row(
          'SELECT `citizenid`, `conversation_id`, `message` FROM `mica_messages` WHERE `id` = ?',
          [sent.messageId]
        );
        if (!row) throw new Error('the line text was not written');
        assert(sealedKid(row.message) === HARNESS_KID, 'the line text is not sealed');
        const text = openSealed(row.message, harnessKeys(), {
          table: 'mica_messages',
          column: 'message',
          citizenid: String(row.citizenid),
          scope: [row.conversation_id as number]
        });
        assert(text === body, 'the line text opened to something else');
        // A second text from the same line lands in the same thread.
        const again = await expectOk<{ conversationId: number }>('SendMessage', to.citizenid, {
          from: { number: line },
          body: 'again'
        });
        assert(again.conversationId === sent.conversationId, 'a second text opened a new thread');
      } finally {
        await expectOk('UnregisterNumber', line);
      }
      await expectRefusal('invalid_args', 'UnregisterNumber', line);
    }
  },
  {
    // MICA-240: SendInvoice writes an active bill for an offline character, names the calling
    // resource as read before the export's first await, sets an expiry, and persists the
    // notification; the bill list (the bank's read) is that row. Refusals are refused unwritten.
    id: 'exports-send-invoice-creates-a-listed-bill',
    mode: 'standalone',
    tickets: ['MICA-240'],
    run: async (signal) => {
      const payer = await seedCitizen('bill_to');
      const id = await expectOk<{ id: number }>('SendInvoice', payer.citizenid, {
        from: 'LS Customs',
        amount: 1250,
        memo: 'Brake job',
        society: 'mechanic'
      });
      const row = await db.row(
        'SELECT `id`, `citizenid`, `from_label`, `amount`, `memo`, `society`, `payee`, `resource`, ' +
          '`status`, `expires_at`, UNIX_TIMESTAMP() AS `now` FROM `mica_invoices` WHERE `citizenid` = ? ' +
          "AND `status` = 'active' ORDER BY `id`",
        [payer.citizenid]
      );
      if (!row) throw new Error('no active invoice is listed for the payer');
      assert(Number(row.id) === id.id, 'the listed invoice is not the one SendInvoice returned');
      assert(
        Number(row.amount) === 1250 && row.society === 'mechanic' && row.payee === null,
        'the bill is not as sent'
      );
      assert(
        row.from_label === 'LS Customs' && row.memo === 'Brake job',
        'the bill text is not as sent'
      );
      assert(
        row.resource === GetCurrentResourceName(),
        `the bill names resource '${String(row.resource)}', not the caller`
      );
      assert(Number(row.expires_at) > Number(row.now), 'the bill expires in the past');
      await eventually(
        async () =>
          (await db.count(
            "SELECT COUNT(*) FROM `mica_notifications` WHERE `citizenid` = ? AND `app` = 'bank'",
            [payer.citizenid]
          )) || null,
        5_000,
        signal,
        'a persisted invoice notification'
      );

      await expectRefusal('invalid_args', 'SendInvoice', payer.citizenid, {
        from: 'X',
        amount: 5,
        society: 'police',
        payee: payer.citizenid
      });
      await expectRefusal('invalid_args', 'SendInvoice', payer.citizenid, {
        from: 'X',
        amount: 0,
        society: 'police'
      });
      await expectRefusal('unknown_player', 'SendInvoice', unique('ghost'), {
        from: 'X',
        amount: 5,
        society: 'police'
      });
      const bills = await db.count('SELECT COUNT(*) FROM `mica_invoices` WHERE `citizenid` = ?', [
        payer.citizenid
      ]);
      assert(bills === 1, `${bills} invoices for the payer, not 1: a refusal wrote one`);
    }
  },
  {
    // No ticket: the first public export API, which predates the MICA project. The offline
    // writes — a contact, a media item, a notification under an `ext_` group — land as rows for
    // an offline character, and unsafe input is refused.
    id: 'exports-offline-writes-land-for-an-offline-character',
    mode: 'standalone',
    tickets: [],
    run: async (signal) => {
      const who = await seedCitizen('writes');
      const contact = await expectOk<{ id: number }>('AddContact', who.citizenid, {
        firstname: 'Dispatch',
        phone: '911'
      });
      assert(
        (await db.count('SELECT COUNT(*) FROM `mica_contacts` WHERE `id` = ? AND `citizenid` = ?', [
          contact.id,
          who.citizenid
        ])) === 1,
        'AddContact wrote no contact for the citizen'
      );
      const media = await expectOk<{ id: number }>('AddMedia', who.citizenid, {
        kind: 'link',
        url: 'https://example.invalid/integration.png'
      });
      assert(
        (await db.count('SELECT COUNT(*) FROM `mica_media` WHERE `id` = ? AND `citizenid` = ?', [
          media.id,
          who.citizenid
        ])) === 1,
        'AddMedia wrote no media row for the citizen'
      );
      await expectRefusal('invalid_args', 'AddMedia', who.citizenid, {
        kind: 'link',
        url: 'javascript:alert(1)'
      });
      const app = `ext_${GetCurrentResourceName().replace(/[^a-z0-9_]/g, '_')}`;
      const pushed = await expectOk<{ delivered: boolean }>('SendNotification', who.citizenid, {
        app,
        sourceLabel: 'Integration',
        title: 'Hello',
        body: 'offline'
      });
      assert(pushed.delivered === false, 'an offline notification was reported delivered');
      await eventually(
        async () =>
          (await db.count(
            'SELECT COUNT(*) FROM `mica_notifications` WHERE `citizenid` = ? AND `app` = ?',
            [who.citizenid, app]
          )) || null,
        5_000,
        signal,
        'the persisted ext_ notification'
      );
      await expectRefusal('invalid_args', 'SendNotification', who.citizenid, {
        app: 'notanapp',
        title: 'x'
      });
    }
  },
  {
    // No ticket: the signal exports predate the MICA project. The global level and dead zones
    // are server state an export sets and clears with no player present.
    id: 'exports-signal-levels-and-dead-zones',
    mode: 'standalone',
    tickets: [],
    run: async () => {
      await expectOk('SetGlobalSignal', 1);
      await expectOk('ClearGlobalSignal');
      const zone = await expectOk<number>('AddDeadZone', { x: 0, y: 0, z: 0, radius: 25 });
      assert(Number.isInteger(zone), `AddDeadZone answered ${String(zone)}, not an id`);
      await expectOk('RemoveDeadZone', zone);
      await expectRefusal('invalid_args', 'RemoveDeadZone', zone);
      await expectRefusal('invalid_args', 'AddDeadZone', { x: 0, y: 0, z: 0, radius: 0 });
    }
  },
  {
    // MICA-224, MICA-232, MICA-263: every source-keyed export refuses a source nobody holds
    // with a reason a caller can branch on — never `ok`, never `internal_error`, never a throw.
    id: 'exports-source-keyed-refuse-an-absent-player',
    mode: 'standalone',
    tickets: ['MICA-224', 'MICA-232', 'MICA-263'],
    run: async () => {
      const calls: [string, unknown[]][] = [
        ['GetBatteryLevel', [ABSENT_SOURCE]],
        ['SetBatteryLevel', [ABSENT_SOURCE, 50]],
        ['AddBatteryCharge', [ABSENT_SOURCE, 5]],
        ['SetCharging', [ABSENT_SOURCE, true]],
        ['GetCitizenIdFromSource', [ABSENT_SOURCE]],
        ['IsPhoneOpen', [ABSENT_SOURCE]],
        ['SetPhoneEnabled', [ABSENT_SOURCE, false]],
        ['LockPhone', [ABSENT_SOURCE]],
        ['UnlockPhone', [ABSENT_SOURCE]],
        ['IsPhoneLocked', [ABSENT_SOURCE]],
        ['IsInCall', [ABSENT_SOURCE]],
        ['HasPhoneItem', [ABSENT_SOURCE]],
        ['GetSignal', [ABSENT_SOURCE]],
        ['SetSignal', [ABSENT_SOURCE, 2]],
        ['OpenApp', [ABSENT_SOURCE, 'mail', {}]],
        ['CreateCall', [ABSENT_SOURCE, '555']]
      ];
      const wrong: string[] = [];
      for (const [name, args] of calls) {
        const outcome = await callExport<Outcome>(name, ...args);
        if (!outcome || outcome.ok !== false || outcome.reason !== 'unknown_player') {
          wrong.push(`${name} → ${JSON.stringify(outcome)}`);
        }
      }
      // A device that is not one is refused before the player is looked at (MICA-263).
      const bad = await callExport<Outcome>('IsPhoneOpen', ABSENT_SOURCE, 'watch');
      if (!bad || bad.ok !== false || bad.reason !== 'invalid_args') {
        wrong.push(`IsPhoneOpen(…, 'watch') → ${JSON.stringify(bad)}`);
      }
      if (wrong.length > 0) throw new Error(wrong.join('; '));
    }
  }
];
