import { createCrudStore, byNewest } from '@gphone/sdk';
import type { Note } from '@shared/types';

/**
 * Notes' own data layer, inside the app.
 *
 * It used to be `web/src/services/notes.ts` plus `sdk/hooks/useNotes.ts` — a store in core
 * and a hook in the SDK, for an app declaring `core: false`. Neither is something an app
 * installed from the Store can add, so Notes was an add-on in name and a first-party app
 * in structure; `sdk/coreBoundary.test.ts` counted seven references proving it.
 *
 * `service: 'notes'` routes through the one generic NUI callback, so `shared/routes.ts`
 * needs no row and core never learns this app exists. The factory still comes from the
 * SDK, because ordering, the `loaded` flag and refusing to assert a write the server has
 * not taken are not things every app should rediscover.
 *
 * ## Built on first use, not at module scope
 *
 * `createCrudStore(...)` at the top level is evaluated whenever anything imports this
 * file — and if that happens while the `@gphone/sdk` barrel is still initialising, the
 * imports come back `undefined` and the store is built from nothing. `lazyBadge` exists
 * for the identical reason. Deferring to first use means the barrel is always finished by
 * the time the factory is called, whatever imported what.
 */
type NotesStore = ReturnType<typeof build>;

const build = () =>
  createCrudStore<Note, Omit<Note, 'id' | 'citizenid'>>(
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

let instance: NotesStore | null = null;
const store = (): NotesStore => (instance ??= build());

/**
 * The same surface `createCrudStore` returns, resolved through `store()`.
 *
 * `subscribe` is what makes this a Svelte store, so it has to be present as a property
 * rather than reached through a getter call at the use site.
 */
export const notes = {
  subscribe: (run: Parameters<NotesStore['subscribe']>[0]) => store().subscribe(run),
  get loaded() {
    return store().loaded;
  },
  load: () => store().load(),
  add: (draft: Omit<Note, 'id' | 'citizenid'>) => store().add(draft),
  update: (row: Note) => store().update(row),
  delete: (id: number) => store().delete(id)
};

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
