/**
 * `@gphone/sdk/core` — the surface only a `core: true` app may import.
 *
 * One export today. `useNuiBridge` is the raw transport: any registered NUI callback,
 * by name. An add-on with it can reach everything every other permission guards, so it
 * is not on `@gphone/sdk` — `boundary.test.ts` refuses it to anything `core: false`, and
 * a Store-installed bundle cannot resolve this entry at all. MICA-16.
 */
export { useNuiBridge } from './useNuiBridge';
