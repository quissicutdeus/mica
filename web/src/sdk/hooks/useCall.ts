import { callStore } from '../../services/call';

/**
 * OS Service Hook for active phone call management.
 */
export function useCall() {
  return {
    callStore,
    startCall: (number: string, name?: string) => callStore.startCall(number, name),
    endCall: () => callStore.endCall(),
    answerCall: () => callStore.answerCall(),
    toggleSpeaker: () => callStore.toggleSpeaker()
  };
}
