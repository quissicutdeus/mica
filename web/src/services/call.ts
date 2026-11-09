// SPDX-FileCopyrightText: 2025 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { get, writable } from 'svelte/store';
import { fetchNui } from '../nui/fetchNui';
import { call } from '../nui/call';
import { phoneContract } from '@mica/shared/contracts/phone';
import { t } from '../../../sdk/i18n';
import { toast } from '../shell/state/toast';
import type { CallState, CallStatus } from '../../../sdk/vocabulary/call';

/** `CallState['line']`: only the shell sets it, only on a ring; idle drops it (MICA-307). */
type CallLine = NonNullable<CallState['line']>;

const initialState: CallState = {
  status: 'idle',
  number: '',
  duration: 0,
  speaker: false,
  speakerAvailable: false,
  muted: false
};

function createCallStore() {
  const store = writable<CallState>(initialState);
  const { subscribe, set, update } = store;

  let durationInterval: NodeJS.Timeout | null = null;
  /** Bumped by every dial, so a late refusal can tell whether its dial is still on screen. */
  let dialSeq = 0;

  return {
    subscribe,
    /**
     * Dial. The server's push (`callStatus`) moves the call on from `dialing`; the NUI reply
     * only says whether a dial went out at all.
     *
     * A refused dial goes back to idle with a toast (MICA-473). The client answers `{ error }`
     * for a number the server's `phoneNumber` rule would refuse (MICA-466), and a failed round
     * trip throws the same way; either way nobody is on the line, and staying on `dialing`
     * left the player looking at a call that was never placed. Only this dial is undone: a
     * ring or a second dial that arrived meanwhile is left alone.
     */
    startCall: async (number: string, name?: string) => {
      const seq = ++dialSeq;
      update((state) => ({
        ...state,
        status: 'dialing',
        number,
        name,
        line: undefined,
        duration: 0
      }));

      try {
        await fetchNui('startCall', { number });
      } catch (e) {
        console.error('Failed to start call', e);
        if (seq !== dialSeq || get(store).status !== 'dialing') return;
        stopTimer();
        set(initialState);
        // The shell's catalog, not Phone's: Contacts, Jobs, Marketplace and the lock screen dial
        // too, often before Phone has mounted and registered its own strings.
        toast.show({ type: 'error', app: 'phone', message: get(t)('shell.callFailed') });
      }
    },
    endCall: async () => {
      stopTimer();
      try {
        await fetchNui('endCall');
      } catch (e) {
        console.error('Failed to end call', e);
      }
      set(initialState);
    },
    answerCall: async () => {
      update((s) => ({ ...s, status: 'connected' }));
      startTimer();
      try {
        await fetchNui('answerCall');
      } catch (e) {
        console.error('Failed to answer call', e);
      }
    },
    toggleMute: async () => {
      update((s) => {
        const muted = !s.muted;
        fetchNui('toggleMute', { muted }).catch((e) => console.error(e));
        return { ...s, muted };
      });
    },
    /**
     * Ask the server (MICA-246). Shown at once, then corrected to what the server answered:
     * it refuses a call that is not connected, and who hears it is its decision, not the
     * phone's. A failed round trip puts the control back where it was.
     */
    toggleSpeaker: async () => {
      const before = get(store);
      if (!before.speakerAvailable) return;
      const enabled = !before.speaker;
      update((s) => ({ ...s, speaker: enabled }));
      try {
        const reply = await call(phoneContract, 'speaker', { enabled });
        update((s) => (s.status === 'connected' ? { ...s, speaker: reply?.enabled === true } : s));
      } catch (e) {
        console.error('Failed to toggle speaker', e);
        update((s) => (s.status === 'connected' ? { ...s, speaker: before.speaker } : s));
      }
    },
    // NUI Event handlers
    setIncoming: (number: string, name?: string, line?: CallLine) => {
      update((s) => ({
        ...s,
        status: 'incoming',
        number,
        name,
        line,
        duration: 0
      }));
    },
    /**
     * `speakerAvailable` is read only with `connected`, the one status the server sends it
     * with; any other status leaves what the call already knows alone.
     */
    setStatus: (status: CallStatus, speakerAvailable?: boolean) => {
      update((s) => {
        if (status === 'connected' && s.status !== 'connected') {
          startTimer();
        } else if (status === 'idle') {
          stopTimer();
          return initialState;
        }
        if (status === 'connected' && speakerAvailable !== undefined) {
          // Withdrawn mid-call means the server switched it off too, so it cannot stay "on".
          return {
            ...s,
            status,
            speakerAvailable,
            speaker: speakerAvailable ? s.speaker : false
          };
        }
        return { ...s, status };
      });
    }
  };

  function startTimer() {
    if (durationInterval) clearInterval(durationInterval);
    durationInterval = setInterval(() => {
      update((s) => ({ ...s, duration: s.duration + 1 }));
    }, 1000);
  }

  function stopTimer() {
    if (durationInterval) {
      clearInterval(durationInterval);
      durationInterval = null;
    }
  }
}

export const callStore = createCallStore();
