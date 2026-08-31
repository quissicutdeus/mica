import { writable } from 'svelte/store';
import { fetchNui } from '../nui/fetchNui';

export type CallStatus = 'idle' | 'dialing' | 'connected' | 'incoming';

export interface CallState {
  status: CallStatus;
  number: string;
  name?: string;
  duration: number; // in seconds
  speaker: boolean;
  muted: boolean;
}

const initialState: CallState = {
  status: 'idle',
  number: '',
  duration: 0,
  speaker: false,
  muted: false
};

function createCallStore() {
  const { subscribe, set, update } = writable<CallState>(initialState);

  let durationInterval: NodeJS.Timeout | null = null;

  return {
    subscribe,
    startCall: async (number: string, name?: string) => {
      update((state) => ({
        ...state,
        status: 'dialing',
        number,
        name,
        duration: 0
      }));

      try {
        await fetchNui('startCall', { number });
        // In a real app, we might wait for a 'callConnected' event or similar
        // But here we rely on the backend/mock to send events or updates.
        // If using the registry, the mock can simulate the delay and return.
      } catch (e) {
        console.error('Failed to start call', e);
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
    toggleSpeaker: async () => {
      update((s) => {
        const newSpeaker = !s.speaker;
        fetchNui('toggleSpeaker', { enabled: newSpeaker }).catch((e) => console.error(e));
        return { ...s, speaker: newSpeaker };
      });
    },
    // NUI Event handlers
    setIncoming: (number: string, name?: string) => {
      update((s) => ({
        ...s,
        status: 'incoming',
        number,
        name,
        duration: 0
      }));
    },
    setStatus: (status: CallStatus) => {
      update((s) => {
        if (status === 'connected' && s.status !== 'connected') {
          startTimer();
        } else if (status === 'idle') {
          stopTimer();
          return initialState;
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
