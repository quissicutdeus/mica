import { registerFacet } from '../../../../sdk/host/current';
import { callStore } from '../../services/call';
import { callLog, loadCallLog } from '../../services/callLog';

/**
 * OS Service Hook for active phone call management, plus the player's call history.
 */
export function call() {
  return {
    callStore,
    startCall: (number: string, name?: string) => callStore.startCall(number, name),
    endCall: () => callStore.endCall(),
    answerCall: () => callStore.answerCall(),
    toggleSpeaker: () => callStore.toggleSpeaker(),
    callLog,
    loadCallLog
  };
}

registerFacet('call', call);
