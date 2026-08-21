// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';

const transport = vi.hoisted(() => ({ fetchNui: vi.fn() }));
vi.mock('../nui/fetchNui', () => ({ fetchNui: transport.fetchNui }));

import { getMyAccounts, followAccount, getReactionsFor } from './accounts';

describe('accounts service', () => {
  it('getMyAccounts asks by app and defaults to an empty page', async () => {
    transport.fetchNui.mockResolvedValueOnce({ rows: [], limit: 3 });
    await getMyAccounts('blabber');
    expect(transport.fetchNui).toHaveBeenCalledWith(
      'getMyAccounts',
      { app: 'blabber' },
      { defaultValue: { rows: [], limit: 3 } }
    );
  });

  it('followAccount posts the app and both ids', async () => {
    transport.fetchNui.mockResolvedValueOnce(undefined);
    await followAccount({ app: 'blabber', follower_account_id: 1, followee_account_id: 2 });
    expect(transport.fetchNui).toHaveBeenCalledWith(
      'followAccount',
      {
        app: 'blabber',
        follower_account_id: 1,
        followee_account_id: 2
      },
      undefined
    );
  });

  it('getReactionsFor defaults to an empty map', async () => {
    transport.fetchNui.mockResolvedValueOnce({});
    await getReactionsFor({ app: 'blabber', target_table: 'gphone_blabs', target_ids: [1] });
    expect(transport.fetchNui).toHaveBeenCalledWith(
      'getReactionsFor',
      { app: 'blabber', target_table: 'gphone_blabs', target_ids: [1] },
      { defaultValue: {} }
    );
  });
});
