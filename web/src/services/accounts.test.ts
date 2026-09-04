// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';

const transport = vi.hoisted(() => ({ fetchNui: vi.fn() }));
vi.mock('../nui/fetchNui', () => ({ fetchNui: transport.fetchNui }));

import { getMyAccounts, followAccount, getReactionsFor } from './accounts';

// Every custom action here is contracted, so the transport sees the generic `svc`
// envelope rather than a named route (MICA-213).
describe('accounts service', () => {
  it('getMyAccounts asks by app and defaults to an empty page', async () => {
    transport.fetchNui.mockResolvedValueOnce({ rows: [], limit: 3 });
    await getMyAccounts('blabber');
    expect(transport.fetchNui).toHaveBeenCalledWith(
      'svc',
      { service: 'accounts', action: 'mine', data: { app: 'blabber' } },
      { defaultValue: { rows: [], limit: 3 } }
    );
  });

  it('followAccount posts the app and both ids', async () => {
    transport.fetchNui.mockResolvedValueOnce(undefined);
    await followAccount({ app: 'blabber', follower_account_id: 1, followee_account_id: 2 });
    expect(transport.fetchNui).toHaveBeenCalledWith('svc', {
      service: 'accounts',
      action: 'follow',
      data: {
        app: 'blabber',
        follower_account_id: 1,
        followee_account_id: 2
      }
    });
  });

  it('getReactionsFor defaults to an empty map', async () => {
    transport.fetchNui.mockResolvedValueOnce({});
    await getReactionsFor({ app: 'blabber', target_table: 'mica_blabs', target_ids: [1] });
    expect(transport.fetchNui).toHaveBeenCalledWith(
      'svc',
      {
        service: 'accounts',
        action: 'reactionsFor',
        data: { app: 'blabber', target_table: 'mica_blabs', target_ids: [1] }
      },
      { defaultValue: {} }
    );
  });
});
