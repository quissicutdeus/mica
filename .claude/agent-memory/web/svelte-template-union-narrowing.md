# A union state does not narrow in `{:else if}`

`let confirming = $state<'rotate' | Member | null>(null)` followed by
`{#if confirming === 'rotate'} … {:else if confirming !== null} {confirming.alias}`
passes `svelte-check` and `pnpm typecheck`, then fails `pnpm lint:web` with
`@typescript-eslint/no-unsafe-assignment` ("error typed value"): the eslint
Svelte parser does not carry the narrowing across template branches (MICA-254,
Dark Chat's channel info).

Fix: one state per dialog (`rotating: boolean`, `removing: Member | null`) and
test each by truthiness. Typecheck alone is not the gate for a `.svelte`
template; run `lint:web` too.

Related, from the same lane: `ReportDialog` costs an add-on **two** manifest
permissions, `reports` and `notifications` (`PERMISSION_OF` in
`sdk/permissions.ts`), because it confirms with a toast.
