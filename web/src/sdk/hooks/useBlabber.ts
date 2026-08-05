import {
  accountLimit,
  accountsLoaded,
  activeAccount,
  activeAccountId,
  canClaimAnother,
  claimAccount,
  updateAccount,
  deleteBlab,
  editBlab,
  editWindow,
  engagement,
  feed,
  followingFeed,
  followers,
  following,
  followStats,
  loadFollowers,
  loadFollowing,
  loadFollowingList,
  loadFollowStats,
  toggleFollow,
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
    followingFeed,
    /**
     * The two lists behind a profile's counts. Read-only from an app's side: they are filled by
     * the loaders below, which name whose list is wanted.
     */
    followers,
    following,
    loadFollowers: (accountId: number) => loadFollowers(accountId),
    loadFollowingList: (accountId: number) => loadFollowingList(accountId),
    followStats,
    loadFollowing: () => loadFollowing(),
    loadFollowStats: (accountId: number) => loadFollowStats(accountId),
    toggleFollow: (accountId: number) => toggleFollow(accountId),
    myAccounts,
    accountsLoaded,
    accountLimit,
    canClaimAnother,
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
    updateAccount: (id: number, patch: Parameters<typeof updateAccount>[1]) =>
      updateAccount(id, patch),
    postBlab: (body: string, replyTo?: number | null) => postBlab(body, replyTo),
    editBlab: (id: number, body: string) => editBlab(id, body),
    deleteBlab: (id: number) => deleteBlab(id)
  };
}
