import { defineAddonMock } from '@mica/sdk/dev';
import { addonError } from '@mica/shared/addonService';
import { NOTE_ADDED, notes, type Note } from './service';

/**
 * Your server half, mocked for `pnpm dev` — **never in the bundle you ship.**
 *
 * `pnpm dev` runs your add-on in the demo phone, where there is no FiveM server and so no
 * `my_addon_server/` to answer the note list's store. This answers instead, inside your add-on's
 * own sandboxed frame: the phone never sees it, and only your own service id is mocked — a call
 * to any other is refused by the phone exactly as it is in game.
 *
 * The handlers have the same type `exports.mica:RegisterService` takes — `(citizenid, input,
 * source)`, answering the declared output or `addonError(...)` — so this file is a working
 * sketch of `server.lua`. Each call's input is parsed against `src/service.ts` before a handler
 * runs, and a refusal reaches your UI the way it would in game. Every call is made as one
 * fixed dev citizen.
 *
 * `push(event, payload)` is `exports.mica:PushToApp`: it reaches `useAppEvents('my_addon')`.
 *
 * Only `vite.config.ts`'s development entry imports this file, and a production build refuses
 * `@mica/sdk/dev` from anywhere — so nothing here can reach a player.
 */

/** As `server.lua` caps it. */
const MAX_NOTES = 50;

const rows: Note[] = [];
let nextId = 1;

export default defineAddonMock(notes, ({ push }) => ({
  list: () => rows,

  add: (_citizenid, { text }) => {
    if (rows.length >= MAX_NOTES) return addonError(`You already have ${MAX_NOTES} notes.`);
    const note: Note = { id: nextId++, text, created: Date.now() };
    rows.push(note);
    push(NOTE_ADDED, { ...note });
    return note;
  }
}));
