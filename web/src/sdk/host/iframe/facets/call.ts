import { registerFacet } from '../../current';
import type { Facets } from '../../inProcess/facets';
import { fn, store, type AsTwin } from './_shared';

type Twin = AsTwin<ReturnType<typeof import('../../inProcess/facets/call').call>>;

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
  };
}
// The Twin above is what an iframe can honestly offer (MICA-26) -- Readable in place of
// Writable, and (for the handful of members noted above) async where the wire makes
// something inProcess exposes synchronously. This is the one place that gap is bridged,
// once per facet, rather than a blanket cast hiding the whole object from the checker.
registerFacet('call', call as unknown as Facets['call']);
