/**
 * `@gphone/sdk/core` — the surface only a `core: true` app may import.
 *
 * One export today. `useNuiBridge` is the raw transport: any registered NUI callback,
 * by name. An add-on with it can reach everything every other permission guards, so it
 * is not on `@gphone/sdk` — `boundary.test.ts` refuses it to anything `core: false`. The
 * specifier is unresolvable out-of-tree for a Store-installed bundle, but that is a
 * static guard, not a runtime one — nothing stops such a bundle calling NUI directly by
 * name. In-process, `useNuiBridge` is gated only by that static `core:`-only import
 * check; it has no host-protocol permission row and is not `guarded()`. Runtime refusal
 * for it arrives with Step 4 (out-of-context add-ons), MICA-16.
 */
export { useNuiBridge } from './useNuiBridge';
