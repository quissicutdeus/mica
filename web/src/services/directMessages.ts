// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { call, callOr } from '../nui/call';
import { dmsContract } from '@mica/shared/contracts/dms';
import type { DirectMessage, DirectMessageThread } from '@mica/shared/types';

/**
 * The `dms` service, for any social app (MICA-390). Every call names its `app`, and the server
 * looks a policy up by it — an app without one is refused, so this is a door, not a grant.
 *
 * Reads answer an empty result on failure and writes reject, the split `fetchNui` documents:
 * an inbox that failed to load renders as empty, a message that failed to send has to say so.
 * That is exactly what Blabber's `useService('blabber_dms')` calls did before this existed.
 */

const emptyPage = (): { rows: DirectMessage[]; nextCursor: number | null } => ({
  rows: [],
  nextCursor: null
});

export const dmThreads = (app: string): Promise<DirectMessageThread[]> =>
  callOr(dmsContract, 'threads', { app }, [] as DirectMessageThread[]);

export const dmThread = (
  app: string,
  query: { account_id: number; peer_account_id: number; cursor?: number | null; limit?: number }
): Promise<{ rows: DirectMessage[]; nextCursor: number | null }> =>
  callOr(dmsContract, 'get', { ...query, app }, emptyPage());

export const sendDm = (
  app: string,
  input: { account_id: number; peer_account_id: number; body: string }
): Promise<DirectMessage> => call(dmsContract, 'send', { ...input, app });

export const markDmsRead = (
  app: string,
  input: { account_id: number; peer_account_id: number }
): Promise<boolean> => call(dmsContract, 'read', { ...input, app });
