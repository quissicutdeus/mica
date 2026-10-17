// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { guarded } from './guard';

/**
 * Private, one-to-one messages between two accounts in your app. MICA-390.
 *
 * Built on the shared identity layer `useAccounts` reads: every member names the account you
 * are acting **as** (`account_id`, one of `useAccounts().getMyAccounts(appId)`) and the one
 * at the other end (`peer_account_id`). Both live in `appId`, and every call carries it, so
 * a thread is always within one app.
 *
 * ```ts
 * const dms = useDirectMessages('dating');
 * const inbox = await dms.threads(); // every correspondent, across all of my accounts here
 * const { rows } = await dms.thread({ account_id: me, peer_account_id: them }); // newest first
 * await dms.send({ account_id: me, peer_account_id: them, body: 'hi' });
 * await dms.markRead({ account_id: me, peer_account_id: them });
 * ```
 *
 * **Reads never reject**: `threads()` answers `[]` and `thread()` an empty page on any
 * failure, as every list read in the SDK does. **Writes do**: `send` and `markRead` reject,
 * with a `ServiceRefusal` when the server keyed its answer, so a caller can tell that nothing
 * happened.
 *
 * ## What decides who may message whom
 *
 * The server, per app. Owning `account_id`, the peer being an active account in the same app,
 * no messaging yourself and a block in either direction are checked for every app; whatever
 * else your app needs — "only after a match" — is a policy your app's server half registers.
 * **An app with no policy is refused outright**, so this hook does nothing until one exists.
 *
 * ## What an add-on can reach
 *
 * Only its own app's messages. In a sandboxed frame the shell replaces `appId` with the
 * frame's own before anything is sent, so naming another app still reads and writes your own.
 * Needs the `social` permission, the same one `useAccounts` does.
 */
export function useDirectMessages(appId: string) {
  return guarded('useDirectMessages', appId).facets.directMessages(appId);
}
