import { mailStore, unreadMailCount } from '../../store/mail';
export { mailStore, unreadMailCount };

/**
 * OS Service Hook for email messaging.
 */
export function useMail() {
  return {
    mailStore,
    unreadMailCount,
    deleteMail: (id: number) => mailStore.delete(id),
    markAsRead: (id: number) => mailStore.markAsRead(id),
    archiveMail: (id: number, archiveState = true) => mailStore.archive(id, archiveState),
    addReceivedMail: (newMail: any) => mailStore.addReceivedMail(newMail)
  };
}
