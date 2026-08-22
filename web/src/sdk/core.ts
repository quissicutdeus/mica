/**
 * `@gphone/sdk/core` — the surface only a `core: true` app may import.
 *
 * One export today. `useNuiBridge` is the raw transport: any registered NUI callback,
 * by name. An add-on with it can reach everything every other permission guards, so it
 * is not on `@gphone/sdk` — `boundary.test.ts` refuses it to anything `core: false`. The
 * specifier is unresolvable out-of-tree for a Store-installed bundle, and since MICA-16
 * Step 4 that is also a runtime refusal: a `core: false` bundle runs in a sandboxed iframe
 * with no NUI at all, only the `postMessage` protocol in `sdk/host/iframe/`. In-process,
 * `useNuiBridge` is gated only by the static `core:`-only import check; it has no
 * host-protocol permission row and is not `guarded()`.
 */
export { useNuiBridge } from './useNuiBridge';
