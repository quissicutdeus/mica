// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { detectFramework } from '../lib/FrameworkBridge';
import { ServiceEndpoint } from '../lib/ServiceEndpoint';
import { shellContract } from '@mica/shared/contracts/shell';

/**
 * What this server is actually able to do, so the UI can hide what it cannot.
 *
 * The same shape and the same purpose as `Admin.ts`: one server-known fact, answered on
 * request, which the phone uses to decide what to *show*. It is not a boundary and must
 * never be treated as one — a modified client can answer its own `checkCapabilities` and
 * see every app. What stops it there is that the capability it would be faking is enforced
 * where the money actually moves (`Payments.ts`, `Hodlr.ts`, and the fail-closed
 * `getMoney`/`removeMoney`/`addMoney` in `FrameworkBridge`), exactly as `isAdmin` is
 * re-checked at every privileged action rather than trusted from `checkAdmin`.
 *
 * On the `shell` service rather than a service of its own: this is a question about the
 * phone, not about any app on it, and `shell` is one of the two non-app scopes
 * `eventNames.test.ts` recognises. The file is not named `Shell.ts` because
 * `server/lib/shell.ts` already holds the shell service's outbound half and declares the
 * name; naming this one for the service would read as a claim to own that, and a second
 * `shell.ts` in the server tree differing only by case is worse than a file named for what
 * is in it.
 */

/** Everything the phone asks about. One field today; the shape is the extension point. */
export interface Capabilities {
  /**
   * Can money move on this server at all?
   *
   * False only in standalone, where `FrameworkBridge` has no framework to ask: `getMoney`
   * answers the `-Infinity` sentinel and both `removeMoney` and `addMoney` answer `false`.
   * Bank and Hodlr exist to move money, so on such a server they are not broken apps to be
   * error-handled — they are apps with nothing behind them, and hiding them is the honest
   * rendering. (Marketplace moves none; it is a noticeboard.)
   */
  money: boolean;
}

/**
 * `unknown` answers `money: true`, deliberately, and this is the whole of the reasoning.
 *
 * `detectFramework` treats `unknown` as a first-class answer and its docblock is explicit
 * that it must never be folded into a default — because `unknown` does not mean "no
 * framework", it means **no framework has answered yet**. FiveM starts resources in
 * `server.cfg` order, `ensure mica` above `ensure qb-core` is a legal config, and
 * micaOS's own `onResourceStart` fires inside exactly that window. So on an ordinary qb
 * server, `unknown` is a state the boot passes through.
 *
 * Which makes the two wrong answers here wildly asymmetric, and that asymmetry — not a
 * default — is what picks `true`:
 *
 * - Answering `true` where there turns out to be no money costs an error. The app is on
 *   the home screen, the player taps it, and every money call behind it fails closed and
 *   says so. Recoverable, visible, and bounded to whoever tapped.
 * - Answering `false` on a booting qb server deletes Bank and Hodlr from a phone that
 *   works. It is asked once, so the answer sticks for the session; nothing errors, nothing
 *   is logged, and two apps are simply gone. That is the silent failure this repo keeps
 *   paying for.
 *
 * Standalone is the only state that *positively knows* there is no money, because an
 * operator said so in a convar that cannot be raced (see `STANDALONE_CONVAR`). Everything
 * else is "money, as far as this can tell", with the fail-closed money paths underneath it.
 */
export const capabilities = (): Capabilities => ({
  money: detectFramework() !== 'standalone'
});

const app = new ServiceEndpoint<never, typeof shellContract>('shell', null, {
  contract: shellContract,
  disableGet: true,
  disableCreate: true,
  disableUpdate: true,
  disableDelete: true
});

// No payload is read: the answer is a property of the server, identical for every caller,
// so there is nothing here for §2.9 to sanitize and nothing a client could steer.
app.registerEvent('capabilities', async () => capabilities());
