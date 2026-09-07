// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Answer qb-phone's client notification event (MICA-222).
 *
 * `TriggerClientEvent('qb-phone:client:CustomNotification', src, title, text, icon, color,
 * timeout)` is how a qb script puts a line on a player's phone. It becomes the shell's own
 * toast: title and text carried over, the icon, colour and timeout dropped, because the
 * shell's toast has its own look and its own timing and a notification drawn in qb-phone's
 * colours would be the one thing on screen that is not micaOS. Nothing is written -- qb's
 * event was a toast too.
 *
 * Positional arguments, as qb sends them. A qb script that only passes a title still gets
 * a toast; one that passes nothing readable gets nothing.
 */
import { QB_PHONE_CLIENT_EVENTS } from '@mica/shared/qbPhoneEvents';
import { sendNuiMessage } from '../lib/nui';

onNet(QB_PHONE_CLIENT_EVENTS.customNotification, (title: unknown, text: unknown) => {
  const heading = typeof title === 'string' ? title.trim() : '';
  const body = typeof text === 'string' ? text.trim() : '';
  if (!heading && !body) return;
  sendNuiMessage('notify', {
    type: 'info',
    title: heading || undefined,
    message: body || heading
  });
});
