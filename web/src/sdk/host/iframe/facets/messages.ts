import { registerFacet } from '../../current';
import type { Facets } from '../../inProcess/facets';
import { fn, store, type AsTwin } from './_shared';

type Twin = AsTwin<ReturnType<typeof import('../../inProcess/facets/messages').messages>>;

export const unreadMessagesCount = store('messages', [], 'unreadMessagesCount', 0);

export function messages(): Twin {
  return {
    conversationsStore: store('messages', [], 'conversationsStore', []),
    unreadMessagesCount,
    sendMessage: fn('messages', [], 'sendMessage'),
    addReceivedMessage: fn('messages', [], 'addReceivedMessage'),
    startText: fn('messages', [], 'startText')
  };
}
// The Twin above is what an iframe can honestly offer (MICA-26) -- Readable in place of
// Writable, and (for the handful of members noted above) async where the wire makes
// something inProcess exposes synchronously. This is the one place that gap is bridged,
// once per facet, rather than a blanket cast hiding the whole object from the checker.
registerFacet('messages', messages as unknown as Facets['messages']);
