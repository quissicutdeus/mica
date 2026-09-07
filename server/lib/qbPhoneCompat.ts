// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Answer qb-phone's mail events, so qb scripts that mail the phone work unmodified
 * (MICA-222).
 *
 * A server owner replacing qb-phone with micaOS has hundreds of scripts that fire
 * `qb-phone:server:sendNewMail` and `qb-phone:server:sendNewMailToOffline`. Both land on
 * `SendSystemEmail`, the same door the pinned export opens, with the payload shape qb
 * scripts already send: `{ sender, subject, message }`. A qb `button` -- a client event to
 * fire when the mail is tapped -- has no counterpart in micaOS's Mail and is dropped; the
 * README says so.
 *
 * **Two registrations, and the difference is the security boundary.** `sendNewMail`
 * identifies the player by `source`, the way qb-phone's own handler did, so it is a net
 * event: a client may fire it, and the only thing a client can do with it is mail *itself*,
 * rate limited like every other raw net event (`docs/security.md`, category 2). A server
 * script firing it locally inside a player's own event handler is the qb idiom and works
 * the same way. `sendNewMailToOffline` names a citizenid, which is exactly what a client
 * must never be allowed to choose -- so it is `on`, a local handler only, reachable from
 * another server resource and from nothing a player controls. qb-phone registered it as a
 * net event; that was a hole, and this does not carry it across.
 */
import { QB_PHONE_ANSWERED, QB_PHONE_SERVER_EVENTS } from '@mica/shared/qbPhoneEvents';
import { FrameworkBridge } from './FrameworkBridge';
import { allow } from './rateLimit';
import { SendSystemEmail } from '../services/Mail';

/** The `mica_mail` column widths, so a qb payload cannot fail the insert. */
const SENDER_MAX = 100;
const SUBJECT_MAX = 255;
const CONTENT_MAX = 65535;

export interface QbMail {
  sender: string;
  subject: string;
  content: string;
}

/**
 * A qb `mailData` table, or null. Every field is a string a qb script chose; nothing here
 * is trusted further than being cut to the column it lands in. `message` is the body in
 * qb's vocabulary; a script that already speaks micaOS's `content` is accepted too.
 */
export const qbMailFrom = (raw: unknown): QbMail | null => {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as { sender?: unknown; subject?: unknown; message?: unknown; content?: unknown };
  const sender = typeof data.sender === 'string' ? data.sender.trim() : '';
  const subject = typeof data.subject === 'string' ? data.subject.trim() : '';
  const body =
    typeof data.message === 'string'
      ? data.message
      : typeof data.content === 'string'
        ? data.content
        : '';
  if (!sender || !subject || !body.trim()) return null;
  return {
    sender: sender.slice(0, SENDER_MAX),
    subject: subject.slice(0, SUBJECT_MAX),
    content: body.slice(0, CONTENT_MAX)
  };
};

onNet(QB_PHONE_SERVER_EVENTS.sendNewMail, (raw: unknown) => {
  const src = source;
  if (!allow(src, 'mail', 'qbPhoneSendNewMail')) return;
  const player = FrameworkBridge.getPlayer(src);
  if (!player?.citizenid) return;
  const mail = qbMailFrom(raw);
  if (!mail) return;
  void SendSystemEmail(player.citizenid, mail);
});

on(QB_PHONE_SERVER_EVENTS.sendNewMailToOffline, (citizenid: unknown, raw: unknown) => {
  if (typeof citizenid !== 'string' || !citizenid.trim()) return;
  const mail = qbMailFrom(raw);
  if (!mail) return;
  void SendSystemEmail(citizenid.trim(), mail);
});

/**
 * Said once at start, so an owner reading the console knows which qb-phone events are
 * answered here -- and, by the README's list, that nothing else with the prefix is.
 */
console.log(`[mica] answering qb-phone events: ${QB_PHONE_ANSWERED.join(', ')}`);
