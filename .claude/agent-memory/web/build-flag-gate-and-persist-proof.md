# A build-flag gate folds; prove "persists nothing" on two stores

MICA-311, 2026-10-06.

**The gate folds in Vite 8.**
`if (import.meta.env.DEV || import.meta.env.VITE_X === '1') void import('./mod')`
emits no chunk for `mod` in a game build when `VITE_X` is unset. A module-level
`const ALLOWED = <same expression>` folds as well: a registry method guarded by
it shrinks to its `throw`, but its **name** stays in the bundle, so a marker
scan must look for a string that only the dynamic chunk carries. Strings in a
shell locale catalog always ship, whatever the gate.

To prove it, build into the scratchpad with
`pnpm exec vite build --outDir <scratch>`. Do it once plain and once with the
flag set (or `--mode development`), then run
`node scripts/check-no-dev-addon.js <dir>` on each. The plain build passes and
the flagged one fails, which shows both that the gate works and that the check
can fire. Never use `dist/web` for this, because sibling lanes build there.

**"Nothing persisted" has two halves.** In jsdom there is no `localStorage` at
all, and `usePersisted` never touches it. It writes through `services/settings`
`saveSetting`, after a debounce of about 1s. Install a `vi.hoisted`
`localStorage` polyfill before any import (`registry.ts` reads the bare global),
mock `services/settings`, wait more than 1.2s, then assert that the storage
snapshot is unchanged **and** that `saveSetting` was never called. Snapshotting
storage alone misses a home-grid or grant write.
