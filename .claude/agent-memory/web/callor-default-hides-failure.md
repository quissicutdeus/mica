# `callOr`'s default collapses "empty" and "failed" into the same value

`services/*.ts` read helpers built on `callOr(..., [] as T[], { quiet: true })`
resolve `[]` both when the server genuinely answered with zero rows and when the
request never reached it (transport failure, or an error reply like
`"Player not authenticated"`, which is the expected first answer at CEF boot
before a character is selected). A caller that wants to treat "the server said
there is nothing" as a signal — e.g. clearing a local cache entry the current
answer doesn't mention — cannot tell that apart from "we don't know" off the
resolved value alone, and doing it anyway wipes real state on a bad connection.

`call(contract, action, input)` (no `defaultValue`) is the other half of
`nui/call.ts`'s own contract: it throws instead of defaulting, on every failure
kind, and never logs (the `console.warn` in `fetchNui` only fires on the
defaulting path) — so switching a read helper from `callOr` to `call` loses no
quietness, it just moves the decision of what to do about a failure to the
caller's own `try`/`catch`.

**Before renaming the export or adding a second one**, grep every file that does
`vi.mock('.../services/<name>', () => ({ ... }))` — a mock object is a fixed
shape, and a test file outside the one you're allowed to touch may drive the
real hydrate/rehydrate path through that exact mocked function name (e.g.
`registry.test.ts` calls the real `hydrateSettings()` with only `fetchSettings`
mocked). Keeping the export's **name and resolved type** unchanged, and only
swapping `callOr` for `call` inside it, keeps every such mock compiling and
passing untouched, because none of them exercise the rejection path unless the
test explicitly says `mockRejectedValue`. Renaming or adding a second function
breaks any such test immediately with "X is not a function," and it is not yours
to fix if it sits outside your fence.

See [[persisted-default-must-not-persist]] for the sibling problem one layer up
(the overlay that reads this kind of settled state).
