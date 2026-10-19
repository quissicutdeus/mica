# `Object.hasOwn` and `Array#at` fail web's typecheck, not CEF

`Object.hasOwn` shipped in Chromium 93 and `Array.prototype.at` in 92, so CEF
103 runs both, but `web/`'s tsconfig lib stops short of ES2022: `svelte-check`
reports "Property 'hasOwn' does not exist on type 'ObjectConstructor'"
(MICA-255, the `dms` mock's policy table) and "Property 'at' does not exist on
type 'number[]'" (MICA-82, a test file). `vitest` passes both, so only
`pnpm typecheck` catches it — test files included.

Use a `Map` for a keyed lookup table instead. A plain `in` check is wrong for an
object literal, because `'toString' in {}` is true. Use `a[a.length - 1]` for
`.at(-1)`.

Missing utilities, all of which look like they should exist: `m-4`, `mx-4`,
`aspect-[3/4]`, `pt-6`, `pt-8`, `bg-gray-900`, `bg-red-900`, `bg-amber-950`. Pad
a wrapper with `p-4`/`px-4`, use `aspect-square` for photos, `bg-gray-950` for
near-black. A substring search of `app-utilities.css` for `.bg-gray-900` finds a
hit and lies (a longer selector carries the prefix); match the class with a
trailing space/`{`/`,`/`:`, or just run `src/lib/utilityClasses.test.ts`.
