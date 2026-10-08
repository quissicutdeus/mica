// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MockHandler } from '../registry';

export const mocks: Record<string, MockHandler> = {
  /**
   * Broadcasting to people nearby (MICA-111 phase 2), which in a browser means nobody.
   *
   * Deliberately inert rather than fed back into `shell/state/nearbyMusic.ts` — echoing
   * your own broadcast to yourself would put a second player of your own track on your own
   * phone, a fraction out of sync with the first, which is a bug the real client is
   * careful to avoid (`client/services/Music.ts` drops the local player from the roster).
   * `window.pushNearbyMusic` in `shell/devHarness.ts` is how you hear somebody else in a
   * browser.
   */
  'music:broadcastStart': () => ({ ok: true }),
  'music:broadcastUpdate': () => ({ ok: true }),
  'music:broadcastStop': () => ({ ok: true })
};
