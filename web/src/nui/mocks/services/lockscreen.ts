// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MockHandler } from '../registry';

/** The lock screen's passcode (MICA-60) — `null` until `setPasscode` is called. */
let mockPasscodeValue: string | null = null;

export const mocks: Record<string, MockHandler> = {
  // Lock screen passcode (MICA-60). `mockPasscodeValue` stands in for a hashed column —
  // stored in plain text here only because the mock has no server to hash on, and this
  // module never persists across a reload anyway.
  // PENDING (Cody): no `registerEvent` handler exists yet for any of these four.
  'lockscreen:status': async () => ({ hasPasscode: mockPasscodeValue !== null }),
  'lockscreen:set': async (data?: { passcode?: string }) => {
    mockPasscodeValue = typeof data?.passcode === 'string' ? data.passcode : null;
    return { ok: true };
  },
  'lockscreen:check': async (data?: { passcode?: string }) => ({
    ok: mockPasscodeValue !== null && data?.passcode === mockPasscodeValue
  }),
  'lockscreen:clear': async () => {
    mockPasscodeValue = null;
    return { ok: true };
  }
};
