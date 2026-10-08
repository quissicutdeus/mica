// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { PhoneCallLogEntry } from '@mica/shared/types';
import type { MockHandler } from '../registry';

/**
 * The one call in flight, if any. `connectedAt` is null while it's still ringing — set
 * the moment `startCall`'s ring timer decides the other party picked up, and read back
 * by `endCall` to compute a real duration rather than always logging 0.
 */
let activeCall: {
  kind: 'incoming' | 'outgoing';
  number: string;
  connectedAt: number | null;
} | null = null;
let ringTimer: ReturnType<typeof setTimeout> | null = null;
let nextCallLogId = 100;

/**
 * Nobody is ever home at this number — the one deterministic way to exercise a missed
 * call. No hyphen: the Phone app's keypad only ever produces digits, so this has to be
 * dialable by clicking '0' seven times.
 */
const NEVER_ANSWERS = '0000000';
const RING_MS = 350;

const logCall = (kind: PhoneCallLogEntry['kind'], number: string, duration: number): void => {
  const now = new Date().toISOString();
  mockCallLog.unshift({
    id: nextCallLogId++,
    citizenid: 'mock_citizenid',
    kind,
    number,
    duration,
    created_at: now,
    updated_at: now
  });
};

/**
 * `speakerAvailable` rides `connected` exactly as the real client forwards it from the
 * server's `phone:accepted` (MICA-246). The mock always offers the speaker, so the control
 * the browser shows is the one a server with pma-voice shows.
 */
const postCallStatus = (status: 'connected' | 'idle'): void => {
  const data = status === 'connected' ? { status, speakerAvailable: true } : { status };
  window.postMessage({ action: 'callStatus', data }, '*');
};

const mockCallLog: PhoneCallLogEntry[] = [
  {
    id: 3,
    citizenid: 'mock_citizenid',
    kind: 'missed',
    number: '555-0199',
    duration: 0,
    created_at: new Date(Date.now() - 300000).toISOString(),
    updated_at: new Date(Date.now() - 300000).toISOString()
  },
  {
    id: 2,
    citizenid: 'mock_citizenid',
    kind: 'incoming',
    number: '555-0133',
    duration: 45,
    created_at: new Date(Date.now() - 3600000).toISOString(),
    updated_at: new Date(Date.now() - 3600000).toISOString()
  },
  {
    id: 1,
    citizenid: 'mock_citizenid',
    kind: 'outgoing',
    number: '555-0144',
    duration: 122,
    created_at: new Date(Date.now() - 86400000).toISOString(),
    updated_at: new Date(Date.now() - 86400000).toISOString()
  }
];

export const mocks: Record<string, MockHandler> = {
  getCallLog: () => ({ rows: mockCallLog, nextCursor: null }),

  /**
   * Call. There is only ever one player, so `startCall` plays both ends: it rings for
   * `RING_MS`, then either connects (posting the same `callStatus` window message the
   * real client forwards from the server's `phone:accepted` push) or, for
   * `NEVER_ANSWERS`, gives up and logs a missed call — mirroring
   * `server/services/Phone.ts`'s own caller-always-outgoing, duration-0-when-unanswered
   * rule, so the same call log this mock produces is honest against what the real server
   * would have written.
   */
  startCall: (payload?: { number?: string }) => {
    const number = typeof payload?.number === 'string' ? payload.number : 'Unknown';
    if (ringTimer) clearTimeout(ringTimer);
    activeCall = { kind: 'outgoing', number, connectedAt: null };

    ringTimer = setTimeout(() => {
      if (!activeCall) return; // Hung up mid-ring — `endCall` already cleared this.
      if (number === NEVER_ANSWERS) {
        logCall('outgoing', number, 0);
        activeCall = null;
        postCallStatus('idle');
      } else {
        activeCall.connectedAt = Date.now();
        postCallStatus('connected');
      }
    }, RING_MS);

    return true;
  },
  endCall: () => {
    if (ringTimer) {
      clearTimeout(ringTimer);
      ringTimer = null;
    }
    if (activeCall) {
      const duration = activeCall.connectedAt
        ? Math.round((Date.now() - activeCall.connectedAt) / 1000)
        : 0;
      logCall(activeCall.kind, activeCall.number, duration);
      activeCall = null;
    }
    return true;
  },
  answerCall: () => {
    return true;
  },
  toggleMute: async () => {
    return true;
  },
  /**
   * Declining an incoming call — the one path that produces a `missed` row rather than
   * `outgoing`. `logCallEnd` in `server/services/Phone.ts` writes `missed` only to the
   * *target's* own log for an unanswered call, never to the caller's, so this is the
   * only mock action that should ever log that kind.
   */
  rejectCall: (payload?: { number?: string }): boolean => {
    const number = typeof payload?.number === 'string' ? payload.number : 'Unknown';
    logCall('missed', number, 0);
    activeCall = null;
    return true;
  },
  /**
   * DevTools' in-game "Simulate Incoming Call" path. Not what the browser button
   * itself calls — `DeveloperTools.svelte` fakes the toast locally there instead, same
   * as it always has — but the mock still needs an entry, and posting the real
   * `callStatus` message is what makes this genuinely exercisable from a console too.
   */
  simulateIncomingCall: (payload?: { number?: string }): { success: boolean } => {
    const number =
      typeof payload?.number === 'string' && payload.number ? payload.number : '5550100';
    window.postMessage(
      { action: 'callStatus', data: { status: 'incoming', number, name: 'Unknown' } },
      '*'
    );
    return { success: true };
  },

  /** The server's answer is what the phone shows; the mock grants whatever is asked. */
  'phone:speaker': (data?: { enabled?: boolean }) => ({ ok: true, enabled: data?.enabled === true })
};
