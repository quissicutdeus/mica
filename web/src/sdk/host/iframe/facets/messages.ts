import { registerFacet } from '../../current';
import { fn, store } from './_shared';

type Twin = ReturnType<typeof import('../../inProcess/facets/messages').messages>;

export const unreadMessagesCount = store('messages', [], 'unreadMessagesCount', 0);

export function messages(): Twin {
  return {
    conversationsStore: store('messages', [], 'conversationsStore', []),
    unreadMessagesCount,
    sendMessage: fn('messages', [], 'sendMessage'),
    addReceivedMessage: fn('messages', [], 'addReceivedMessage'),
    startText: fn('messages', [], 'startText')
  } as unknown as Twin;
}
registerFacet('messages', messages);
