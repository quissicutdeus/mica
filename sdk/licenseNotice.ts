// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { GOS_BRANCH } from './version';

/**
 * MICA-192, stage 5: the licence, said in the phone rather than only in the repository.
 *
 * AGPL §0 defines "Appropriate Legal Notices" as a prominently visible feature displaying a
 * copyright notice, the absence of warranty, that the work may be conveyed under this
 * licence, and how to view it. §13 adds the one that actually bites for a FiveM resource:
 * a player connecting to a server is a remote user, and an operator running a modified copy
 * owes them its source. None of that was anywhere a player could see it.
 *
 * One string set, read by the About pane, for the reason `privacyNotice.ts` gives for its
 * own: two copies of a legal notice is two things to update and one of them will be wrong.
 * Published for a second reason as well — the README states that an add-on built against
 * this SDK is covered by the same licence with no linking exception, so an add-on author
 * showing the same notice should be able to show the same words.
 *
 * Deliberately not the licence text itself. `LICENSE` is 34KB and the phone is a 400x850
 * screen; §0 asks that a notice tell the reader how to view the licence, not that it recite
 * it. The repository address does that and is the same address §13 needs.
 */

export const LICENSE_COPYRIGHT = 'Copyright (C) 2026 quissicutdeus';

export const LICENSE_NAME = 'GNU Affero General Public License v3.0 or later';

export const LICENSE_SPDX = 'AGPL-3.0-or-later';

export const LICENSE_WARRANTY =
  'gOS is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; ' +
  'without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.';

export const LICENSE_FREEDOMS =
  'gOS is free software. You may redistribute and modify it under the terms of the GNU ' +
  'Affero General Public License as published by the Free Software Foundation, either ' +
  'version 3 of the License, or (at your option) any later version.';

/**
 * The §13 sentence, addressed to the player rather than to the operator.
 *
 * The README says the same thing to whoever runs the server. This says it to whoever is
 * holding the phone, because §13's obligation is owed to *them* — they are the remote user,
 * and a notice that only the operator ever reads discharges nothing.
 */
export const LICENSE_SOURCE_OFFER =
  'This server may be running a modified copy. Section 13 of the licence entitles you to ' +
  'its source; the address below is where this build says its source lives.';

/** The upstream repository, and the default an operator has not overridden. */
export const GOS_SOURCE_URL = 'https://github.com/quissicutdeus/gos';

/**
 * Where the running build's source lives.
 *
 * Branch rather than commit, deliberately. A pinned `/tree/<sha>` answers "the source of
 * *which* version" most precisely, which is what §13 is about — but it rots: a fork with a
 * private repository, a rewritten history or a squashed merge leaves the player holding an
 * address that 404s, which is a worse answer than a branch that resolves. The exact commit
 * is not lost by choosing the branch: About prints it one row above this as
 * `v<calver> (<branch>@<commit>)`, so a reader has both the precise version and a URL that
 * works.
 *
 * `base` is the operator's own repository once `gos_source_url` reaches this (still to
 * come); until then every phone points at upstream, which is the honest answer for a server
 * running an unmodified copy and the wrong one for a fork. That gap is why the offer above
 * says "where this build *says* its source lives" rather than asserting it.
 */
export function sourceUrlForBuild(base: string = GOS_SOURCE_URL): string {
  const repository = base.replace(/\/+$/, '');
  if (!GOS_BRANCH) return repository;
  return `${repository}/tree/${GOS_BRANCH}`;
}
