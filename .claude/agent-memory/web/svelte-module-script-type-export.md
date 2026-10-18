# A type exported from a `.svelte` module script fails `lint:web`

`export type X` in `<script lang="ts" module>` passes `pnpm typecheck`
(svelte-check resolves it), but typescript-eslint cannot see through the
`.svelte` import, so every use in an importing component is an `error` type:
`no-unsafe-assignment`, `no-unsafe-member-access`,
`no-redundant-type-constituents` — twelve errors on MICA-393.

**Fix:** declare the type in a `.ts` file (the app's `store.ts` is the usual
home) and import it from there in both components.
