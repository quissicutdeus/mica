import { addonOutput, defineAddonService } from '@mica/shared/addonService';

/** One note, as the server half stores it and answers it. */
export interface Note {
  id: number;
  text: string;
  /** Milliseconds since the epoch. */
  created: number;
}

/**
 * Your server half, declared once.
 *
 * This object is read at both ends. The UI types its calls from it — the note list's
 * `createCrudStore(notes, …)` and `useService(notes)` both know `list` and `add`, what each
 * takes and what each answers, so a misspelt action or field fails `pnpm check` rather than
 * the player's tap. And `pnpm build` writes it out as
 * `my_addon_server/service.json`, which the Lua resource hands to
 * `exports.mica:RegisterService` — so micaOS parses every payload against exactly what you
 * wrote here before your handler sees it. Edit this file, never the JSON.
 *
 * Imported from `@mica/shared/addonService` — the package `@mica/sdk` re-exports these
 * from — rather than from `@mica/sdk`: the build evaluates this file on its own to write
 * the JSON, and the SDK barrel would pull in every Svelte component to do it. Keep it that
 * way — no Svelte, no hooks, nothing but the declaration and its types. Your UI code
 * imports the same functions from `@mica/sdk` as usual.
 *
 * `id` is your manifest's `id`. It is the service micaOS answers for and the only one your
 * app may call; any other id is refused by the phone before a request is sent.
 *
 * Field kinds: `string` (a `max` is required), `integer`, `number`, `boolean`, `enum`
 * (`values`), and `array` of one of those (a `max` is required). Each may be `optional`
 * (the key may be absent) or `nullable` (`null` is a value). No nested objects.
 * `addonOutput<T>()` is the answer's type for the UI only; it is `undefined` at run time and
 * micaOS does not check what your handler answers.
 */
export const notes = defineAddonService({
  id: 'my_addon',
  actions: {
    list: { input: {}, output: addonOutput<Note[]>() },
    add: {
      input: { text: { type: 'string', min: 1, max: 200 } },
      output: addonOutput<Note>()
    }
  }
});

/** The push `add` sends to every phone of the citizen who added the note. */
export const NOTE_ADDED = 'note_added';
