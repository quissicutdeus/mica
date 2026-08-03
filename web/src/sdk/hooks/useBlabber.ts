import {
  accountsLoaded,
  activeAccount,
  activeAccountId,
  claimAccount,
  deleteBlab,
  editBlab,
  editWindow,
  feed,
  loadMyAccounts,
  myAccounts,
  postBlab
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
    loadMyAccounts: () => loadMyAccounts(),
    claimAccount: (handle: string, displayName?: string) => claimAccount(handle, displayName),
    postBlab: (body: string, replyTo?: number | null) => postBlab(body, replyTo),
    editBlab: (id: number, body: string) => editBlab(id, body),
    deleteBlab: (id: number) => deleteBlab(id)
  };
}
