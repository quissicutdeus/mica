/**
 * `@gphone/sdk/core` — the surface only a `core: true` app may import.
 *
 * One export today. `useNuiBridge` is the raw transport: any registered NUI callback,
 * by name. An add-on with it can reach everything every other permission guards, so it
 * is not on `@gphone/sdk` — `boundary.test.ts` refuses it to anything `core: false`. The
 * specifier is unresolvable out-of-tree for a Store-installed bundle, but that is a
 * static guard, not a runtime one — nothing stops such a bundle calling NUI directly by
 * name. Runtime refusal arrives with the host protocol, MICA-16 step 3.
 */
export { useNuiBridge } from './useNuiBridge';
