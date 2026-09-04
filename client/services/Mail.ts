// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// Mail: only the part that is not a plain relay. The CRUD routes are declared in
// `shared/routes.ts` and registered by the relay.

import { sendNuiMessage } from '../lib/nui';

onNet('mica:client:mail:receive', (newMail: unknown) => {
  sendNuiMessage('receiveMail', newMail);
});
