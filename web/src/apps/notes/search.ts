// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { filterByQuery, t, useSearchProvider, type Note } from '@mica/sdk';
import { get, type Readable } from 'svelte/store';

/**
 * Notes in the phone's own search (MICA-286), answered by whichever root is mounted.
 *
 * The shell holds nothing of this app's — it is `core: false`, so its rows live in a
 * sandboxed frame core may not read, and core may not name it either
 * (`sdk/coreBoundary.test.ts`). The needle comes in, the search runs here against the list
 * already loaded, and only the hits go back. `props` is this app's own deep link, which is
 * what makes a hit open the note rather than the app.
 *
 * Shared by `index.svelte` and `tablet.svelte` because, since MICA-265, the frame mounts
 * one or the other: each registers it during its own setup and drops it when unmounted.
 *
 * `filterByQuery` is the same matcher the in-app search bar uses, so a note findable from
 * inside Notes is findable from the home screen and by the same words.
 */
export function provideNoteSearch(notes: Readable<Note[]>): void {
  useSearchProvider('notes', (needle) => {
    const untitled = get(t)('notes.untitled');
    return filterByQuery(get(notes), needle, (n) => [n.title, n.content]).map((note) => ({
      id: note.id,
      title: note.title || untitled,
      // One line: the drawer's row truncates, and a note's own newlines would otherwise be
      // a stretch of blank subtitle rather than the words after them.
      subtitle: note.content.replace(/\s+/g, ' ').trim(),
      props: { noteId: note.id }
    }));
  });
}
