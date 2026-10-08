// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Note } from '@mica/shared/types';
import { mockNotes } from '../data';
import { defineMockCrud } from '../defineMockCrud';
import type { MockHandler } from '../registry';

export const mocks: Record<string, MockHandler> = {
  // Notes
  ...defineMockCrud<Note>(
    mockNotes,
    {
      // Scoped keys, because Notes goes through the generic service route: the request
      // arrives as `{ service: 'notes', action: 'get' }` rather than as `getNotes`.
      list: 'notes:get',
      create: 'notes:create',
      update: 'notes:update',
      remove: 'notes:delete'
    },
    // MICA-75-wiring: matches the real server, which only ever soft-deletes a note.
    { remove: 'soft', visible: (n) => n.status !== 'deleted', defaults: { status: 'active' } }
  ),

  // Recently Deleted (MICA-75-wiring). Notes is `core: false`, so its two actions are
  // scoped keys (the generic service route) rather than named routes, matching the CRUD
  // block above; Contacts and Media are `core: true` and keep named routes.
  'notes:getDeleted': () => mockNotes.filter((n) => n.status === 'deleted'),
  'notes:restore': (data: { id?: number }) => {
    const note = mockNotes.find((n) => n.id === data?.id && n.status === 'deleted');
    if (!note) return { ok: false };
    note.status = 'active';
    return { ok: true };
  }
};
