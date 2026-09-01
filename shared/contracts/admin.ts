// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineContract, responseType } from '../contract';
import { s } from '../schema';

/**
 * The privileged surface, and the smallest contract in the repo.
 *
 * `admin` is the other non-app service scope. `check` answers whether the **caller's own
 * source** holds one of the configured aces, resolved from the connection rather than from
 * anything the payload says — so there is nothing here for a payload to steer, and a payload
 * arriving at all is a client doing something nobody asked it to.
 */
export const adminContract = defineContract({
  id: 'admin',
  actions: {
    check: { input: s.none(), output: responseType<{ isAdmin: boolean }>() }
  }
});
