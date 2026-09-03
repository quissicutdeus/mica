// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineService } from '../lib/defineService';
import { Note } from '@gos/shared/types';
import { defineContract, responseType } from '@gos/shared/contract';
import { s } from '@gos/shared/schema';
import { restoreWindowDays } from '../lib/retention';

/**
 * Notes' contract, declared here rather than in `shared/contracts/`.
 *
 * Notes is `core: false`, and `shared/` is core — `sdk/coreBoundary.test.ts` refuses core any
 * mention of an app the Store installs, because an add-on is not in this repository and a
 * core file naming one works for the apps shipped in-tree and silently does not for anybody
 * else's. So an add-on's contract lives in the add-on's own resource, next to the
 * `defineService` call it belongs to. This is exactly the shape an external add-on writes,
 * which is the point of it being here rather than a special case.
 */
export const notesContract = defineContract({
  id: 'notes',
  actions: {
    restore: {
      input: s.object({ id: s.positiveInt() }),
      output: responseType<{ ok: boolean }>()
    },
    getDeleted: {
      input: s.none(),
      output: responseType<Note[]>()
    }
  }
});

/**
 * Notes: the whole server half of the app.
 *
 * Replaces the hand-written NoteRepository + ServiceEndpoint pair. The schema drives the
 * `columns` allowlist, the `clientWritable` set, and the generated DDL in
 * the generated `gos.sql` — so they cannot diverge.
 */
export const notes = defineService<Note, typeof notesContract>({
  id: 'notes',
  contract: notesContract,
  access: { read: 'owner', write: 'owner' },
  statuses: ['active', 'archived', 'deleted', 'moderated'],
  schema: {
    title: { type: 'string', length: 255 },
    content: 'text'
  },
  indexes: [{ name: 'citizenid_status_updated', columns: ['citizenid', 'status', 'updated_at'] }]
});

/**
 * Undo a `delete`, within `restoreWindowDays()` of it (MICA-75) — see
 * `Repository.restore` for the ownership scoping and why `updated_at` stands in for a
 * deletion timestamp. `ok: false` covers both "no such note" and "past the window" with
 * the same answer, matching `delete`'s own generic reply shape rather than inventing a
 * reason a client would have no use for beyond "did it work".
 */
notes.app.registerEvent('restore', async (source, cbId, data, citizenid) => {
  const ok = await notes.repo.restore(data.id, citizenid, restoreWindowDays());
  return { ok };
});

/**
 * The "Recently Deleted" list itself (MICA-75-wiring) — every note `restore` above
 * could still bring back. See `Repository.findDeleted` for why this is a named action
 * rather than the generic `get`: `status` is never client-filterable. Notes is `core:
 * false`, so the web side reaches this through `useService('notes').call('getDeleted', {})`
 * rather than a `shared/routes.ts` row.
 */
notes.app.registerEvent('getDeleted', async (source, cbId, data, citizenid) => {
  return await notes.repo.findDeleted(citizenid, restoreWindowDays());
});
