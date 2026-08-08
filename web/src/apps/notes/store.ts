import { createCrudStore, byNewest } from '@gphone/sdk';
import type { Note } from '@shared/types';

/**
 * Notes' own data layer, inside the app.
 *
 * It used to be `web/src/services/notes.ts` plus `sdk/hooks/useNotes.ts` — a store in core
 * and a hook in the SDK, for an app declaring `core: false`. Neither is something an app
 * installed from the Store can add, so Notes was an add-on in name and a first-party app
 * in structure.
 *
 * `service: 'notes'` routes through the one generic NUI callback, so `shared/routes.ts`
 * needs no row and core never learns this app exists. The factory still comes from the
 * SDK, because ordering, the `loaded` flag and refusing to assert a write the server has
 * not taken are not things every app should rediscover.
 *
 * ## Built at module scope, and that is new
 *
 * This was a lazily-constructed singleton, because calling `createCrudStore` at the top
 * level ran it whenever anything imported the file — and if that happened while the
 * `@gphone/sdk` barrel was still initialising, the imports came back `undefined`
 * (`byNewest is not a function`). `@gphone/sdk/app` fixed that at the source: a manifest
 * imports a leaf, so importing the barrel no longer drags every app in behind it. The
 * indirection is gone because the reason for it is.
 *
 * What still holds: **a manifest must not import this file statically.** The registry
 * globs manifests eagerly, so a static import would evaluate this module — and therefore
 * the barrel — during that glob. `preload` uses `import('./store')` for exactly that.
 */
export const notes = createCrudStore<Note, Omit<Note, 'id' | 'citizenid'>>(
  'Notes',
  { list: 'get', create: 'create', update: 'update', remove: 'delete' },
  {
    service: 'notes',
    // Most recently edited first. The list used to arrive in whatever order the server
    // returned and be re-sorted in the component, so a note saved while the list was on
    // screen moved only after the next reload.
    sort: byNewest<Note>('updated_at')
  }
);

/** What the app calls. Was `useNotes` in the SDK; an add-on cannot put one there. */
export function useNotes() {
  return {
    notesStore: notes,
    addNote: (title: string, content: string) => {
      const now = new Date().toISOString();
      return notes.add({ title, content, created_at: now, updated_at: now });
    },
    updateNote: (note: Note) => notes.update(note),
    deleteNote: (id: number) => notes.delete(id)
  };
}
