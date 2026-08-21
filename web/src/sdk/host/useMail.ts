import type { Mail } from '@shared/types';
import { mailStore, unreadMailCount } from '../../services/mail';
import { assertCapability } from '../capability';
export { unreadMailCount };

/**
 * OS Service Hook for email messaging.
 */
export function useMail() {
  assertCapability('mail', 'useMail');
  return {
    mailStore,
    unreadMailCount,
    deleteMail: (id: number) => mailStore.delete(id),
    markAsRead: (id: number) => mailStore.markAsRead(id),
    archiveMail: (id: number, archiveState = true) => mailStore.archive(id, archiveState),
    addReceivedMail: (newMail: Mail) => mailStore.addReceivedMail(newMail)
  };
}
