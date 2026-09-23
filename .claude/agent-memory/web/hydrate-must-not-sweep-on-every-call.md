# A sweeping hydrate may only fire on a real load signal, never on every call

MICA-287 round 1 put a "clear whatever the server's answer omits" sweep straight
into `hydrateSettingsInProcess` — the function wired to the sdk seam's
`hydrateSettings()`, which `Shell.svelte` calls once at page load. That function
is also what `pnpm dev`, the demo container and Playwright's browser mock reach
on every single page load, and the mock's `settings:getAll`
(`web/src/nui/mocks/registry.ts`) is deliberately seeded empty and answers `[]`
every time — there is no "not authenticated" concept in the mock to distinguish
"real empty" from "hasn't loaded a character yet". The sweep read that `[]` as
authoritative and deleted every seeded `mica:*` key on first paint:
`settings-persistence.spec.ts` and several unrelated specs (home-grid, keybinds,
owner-config, nui) failed only because they happened to seed localStorage before
`page.goto('/')`. Review (round 3) caught it; the fix landed a second function
(`hydrateSettingsOnCharacterLoad`, exported from `host/facets/storage.ts`) that
does the sweep, called only from `nuiMessages.ts`'s
`rehydrateSettings`/`rehydrateShell` routes — real server-pushed
character/phone-load signals — while the sdk-seam path reverted to purely
additive, exactly like before the ticket touched it.

**The lesson**: before adding "clear what's missing" logic to any hydrate/sync
function, check every caller — especially ones during boot, in a mock transport,
or in a dev/demo harness — for whether an empty/default answer there means
"nothing exists" or "haven't asked the real source yet". If a mock or a pre-auth
window can produce the same shape as a genuine empty answer, sweeping on that
shape alone is unsafe; gate the sweep on a distinct, real signal instead of
overloading one function for both jobs.

**Also**: a pending debounced write is not a "cancel and let the fresh answer
win" case — a write in flight is _newer_ than any answer that could have already
reflected it, so the correct move is to exclude that key from both sweeping and
overwriting, not to cancel the write. Cancelling broke on a double-fired load
signal (qbx fires two player-loaded events for one real login) that this
ticket's second reviewed attempt hadn't accounted for.

**Also**: `pnpm test:e2e -- <spec files>` run from the repo root does not
reliably forward the file filter through the nested `pnpm --filter web test:e2e`
script — it silently ran the full ~330-test suite instead of the 5 requested
files. `cd web && pnpm exec playwright test <spec files>` is the reliable way to
run a filtered subset; use it when a brief asks for specific spec files, and
don't trust the root-level command's argument passthrough for this.

See [[callor-default-hides-failure]] for the sibling MICA-287 finding about
`callOr` hiding the same real-vs-empty distinction one layer down, and
[[persisted-registry-vs-frame-lifecycle]] for the add-on-frame half of this same
ticket.
