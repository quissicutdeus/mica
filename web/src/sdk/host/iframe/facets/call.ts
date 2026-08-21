import { registerFacet } from '../../current';
import { fn, store } from './_shared';

type Twin = ReturnType<typeof import('../../inProcess/facets/call').call>;

const initialCallState = {
  status: 'idle' as const,
  number: '',
  duration: 0,
  speaker: false,
  muted: false
};

export function call(): Twin {
  return {
    callStore: store('call', [], 'callStore', initialCallState),
    startCall: fn('call', [], 'startCall'),
    endCall: fn('call', [], 'endCall'),
    answerCall: fn('call', [], 'answerCall'),
    toggleSpeaker: fn('call', [], 'toggleSpeaker')
  } as unknown as Twin;
}
registerFacet('call', call);
