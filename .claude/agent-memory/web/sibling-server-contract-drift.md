# Read the sibling server file before calling the web half done

On MICA-82 the lead's brief said Casino refusals "arrive as the generic error
path" (a thrown error) with slugs `invalid_args`/`over_max`. The server lane,
building in parallel, returned refusals as values — `{ ok: false, reason }` —
with `invalid_bet`/`above_max`/`debit_failed`/`round_failed`, added a 20-bet
cap, and paged history rows still `status: 'active'`. Every web gate was green
against the brief's version; the app would have shown a refusal as a successful
spin.

Before reporting, check `git status` for `server/services/<App>.ts` and read its
`defineContract` block and every `refuse(`/`return { ok: false` in the handlers.
Handle both paths in the store: a returned refusal (always a slug, unknown slug
→ generic sentence, never raw) and a thrown error (already a sentence from
`ServiceRefusal`, pass through). Then run the root project's
`server/__tests__/routes.test.ts`, which cross-checks scoped mock keys against
registered events and only means something once the server file exists.
