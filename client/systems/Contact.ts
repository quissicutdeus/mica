// Contacts: only the part that is not a plain relay. The CRUD routes are declared in
// `shared/routes.ts` and registered by the relay.

/**
 * Proximity contact sharing — declared, not built.
 *
 * The callback stays registered because an absent one hangs the NUI request for fifteen
 * seconds. It answers with an error rather than `{ success: true }`, which is what it
 * used to do: the phone then toasted "Contact shared successfully" for a contact that
 * never went anywhere, and no test could tell, because the callback existed and replied.
 *
 * `fetchNui` turns an `{ error }` reply into a thrown error when the caller passes no
 * default, so the app reports it the same way it reports any other refused write. Listed
 * in `UNIMPLEMENTED_ACTIONS`, which is the promise that the web says so visibly.
 *
 * Implementing it means finding players within range and emitting the payload to them.
 */
RegisterNuiCallbackType('shareContact');
on('__cfx_nui:shareContact', (_data: unknown, cb: Function) => {
  cb({ error: 'Sharing a contact is not implemented yet' });
});
