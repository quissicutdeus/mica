// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { deviceOf, perDeviceState } from '../perDevice';
import type { MockContext, MockHandler } from '../registry';

/**
 * The lock screen's passcode (MICA-60), one per device since MICA-264 — `null` until
 * `lockscreen:set` is called on that device. A passcode set on the phone does not lock the
 * tablet, which is the whole of what a per-device identity means here.
 */
const passcodeByDevice = perDeviceState<string | null>(() => null);

export const mocks: Record<string, MockHandler> = {
  // Lock screen passcode (MICA-60). Each value stands in for a hashed column — stored in
  // plain text here only because the mock has no server to hash on, and this module never
  // persists across a reload anyway.
  'lockscreen:status': async (_data?: unknown, context?: MockContext) => ({
    hasPasscode: passcodeByDevice[deviceOf(context)] !== null
  }),
  'lockscreen:set': async (data?: { passcode?: string }, context?: MockContext) => {
    passcodeByDevice[deviceOf(context)] = typeof data?.passcode === 'string' ? data.passcode : null;
    return { ok: true };
  },
  'lockscreen:check': async (data?: { passcode?: string }, context?: MockContext) => {
    const passcode = passcodeByDevice[deviceOf(context)];
    return { ok: passcode !== null && data?.passcode === passcode };
  },
  'lockscreen:clear': async (_data?: unknown, context?: MockContext) => {
    passcodeByDevice[deviceOf(context)] = null;
    return { ok: true };
  }
};
