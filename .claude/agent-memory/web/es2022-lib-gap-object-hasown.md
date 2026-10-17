# `Object.hasOwn` fails web's typecheck, not CEF

`Object.hasOwn` shipped in Chromium 93, so CEF 103 runs it, but `web/`'s
tsconfig lib stops short of ES2022: `svelte-check` reports "Property 'hasOwn'
does not exist on type 'ObjectConstructor'" (MICA-255, the `dms` mock's policy
table). `vitest` passes it, so only `pnpm typecheck` catches it.

Use a `Map` for a keyed lookup table instead. A plain `in` check is wrong for an
object literal, because `'toString' in {}` is true.

Also from that lane: there is no `m-4`, `mx-4` or `aspect-[3/4]` utility. Pad a
wrapper with `p-4`, and use `aspect-square` for photos.
