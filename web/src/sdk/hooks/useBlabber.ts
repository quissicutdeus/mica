import {
  accountsLoaded,
  activeAccount,
  activeAccountId,
  claimAccount,
  deleteBlab,
  editBlab,
  editWindow,
  engagement,
  feed,
  loadEngagement,
  loadMyAccounts,
  loadThread,
  mouthBlab,
  myAccounts,
  postBlab,
  toggleLike,
  unreadMentions,
  clearUnreadMentions,
  dmMessages,
  dmThreads,
  loadDmMessages,
  loadDmThreads,
  sendDm,
  unreadDms
} from '../../services/blabber';

/**
 * OS Service Hook for Blabber: the public feed and the accounts a player posts from.
 *
 * Apps reach stores only through the SDK (§2.7), which is what lets this app be installed from
 * the Store as an add-on rather than only working inside this repo.
 */
export function useBlabber() {
  return {
    feed,
    myAccounts,
    accountsLoaded,
    activeAccount,
    activeAccountId,
    editWindow,
    engagement,
    unreadMentions,
    clearUnreadMentions: () => clearUnreadMentions(),
    dmThreads,
    dmMessages,
    unreadDms,
    loadDmThreads: () => loadDmThreads(),
    loadDmMessages: (peerAccountId: number) => loadDmMessages(peerAccountId),
    sendDm: (peerAccountId: number, body: string) => sendDm(peerAccountId, body),
    loadEngagement: (ids: number[]) => loadEngagement(ids),
    loadThread: (blabId: number) => loadThread(blabId),
    toggleLike: (blabId: number) => toggleLike(blabId),
    mouthBlab: (blabId: number, body?: string) => mouthBlab(blabId, body),
    loadMyAccounts: () => loadMyAccounts(),
    claimAccount: (handle: string, displayName?: string) => claimAccount(handle, displayName),
    postBlab: (body: string, replyTo?: number | null) => postBlab(body, replyTo),
    editBlab: (id: number, body: string) => editBlab(id, body),
    deleteBlab: (id: number) => deleteBlab(id)
  };
}
