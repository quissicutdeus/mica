import { registerFacet } from '../../current';
import type { Mail } from '@shared/types';
import { mailStore, unreadMailCount } from '../../../../services/mail';
export { unreadMailCount };

/**
 * OS Service Hook for email messaging.
 */
export function mail() {
  return {
    mailStore,
    unreadMailCount,
    deleteMail: (id: number) => mailStore.delete(id),
    markAsRead: (id: number) => mailStore.markAsRead(id),
    archiveMail: (id: number, archiveState = true) => mailStore.archive(id, archiveState),
    addReceivedMail: (newMail: Mail) => mailStore.addReceivedMail(newMail)
  };
}

registerFacet('mail', mail);
