import { registerFacet } from '../../current';
import { fn, store } from './_shared';

type Twin = ReturnType<typeof import('../../inProcess/facets/mail').mail>;

export const unreadMailCount = store('mail', [], 'unreadMailCount', 0);

export function mail(): Twin {
  return {
    mailStore: store('mail', [], 'mailStore', []),
    unreadMailCount,
    deleteMail: fn('mail', [], 'deleteMail'),
    markAsRead: fn('mail', [], 'markAsRead'),
    archiveMail: fn('mail', [], 'archiveMail'),
    addReceivedMail: fn('mail', [], 'addReceivedMail')
  } as unknown as Twin;
}
registerFacet('mail', mail);
