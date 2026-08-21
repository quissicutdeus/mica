import { registerFacet } from '../../current';
import { fn, store } from './_shared';

type Twin = ReturnType<typeof import('../../inProcess/facets/notifications').notifications>;

export function notifications(appId?: string): Twin {
  const factoryArgs = [appId];
  return {
    notificationsStore: store('notifications', factoryArgs, 'notificationsStore', []),
    unreadCount: store('notifications', factoryArgs, 'unreadCount', 0),
    totalUnread: store('notifications', factoryArgs, 'totalUnread', 0),
    loaded: store('notifications', factoryArgs, 'loaded', false),
    load: fn('notifications', factoryArgs, 'load'),
    markRead: fn('notifications', factoryArgs, 'markRead'),
    clear: fn('notifications', factoryArgs, 'clear'),
    clearAll: fn('notifications', factoryArgs, 'clearAll')
  } as unknown as Twin;
}
registerFacet('notifications', notifications);
