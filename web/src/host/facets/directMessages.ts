// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { registerFacet } from '../../../../sdk/host/current';
import { dmThreads, dmThread, sendDm, markDmsRead } from '../../services/directMessages';

/**
 * Implementation of the `useDirectMessages` facet — see the hook's doc for the usage contract.
 *
 * `appId` is closed over and spread **last** into every payload, so nothing a caller puts in
 * an input can name a different app. For a sandboxed frame `appId` is already the frame's own
 * (`APP_SCOPED_FACETS`); the server's own `ownedAccount` and per-app policy are what make any
 * of it safe.
 */
export function directMessages(appId: string) {
  return {
    threads: () => dmThreads(appId),
    thread: (query: {
      account_id: number;
      peer_account_id: number;
      cursor?: number | null;
      limit?: number;
    }) => dmThread(appId, query),
    send: (input: { account_id: number; peer_account_id: number; body: string }) =>
      sendDm(appId, input),
    markRead: (input: { account_id: number; peer_account_id: number }) => markDmsRead(appId, input)
  };
}

registerFacet('directMessages', directMessages);
