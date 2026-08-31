import type { AppProps } from '../../manifest';

/**
 * The reactive object `boot.ts` mounts the app with — see MICA-25.
 *
 * `mount()` snapshots whatever `props` object it is given once; the only documented way
 * to update a mounted component's props afterward is to mutate that same `$state` object,
 * which Svelte's own reactivity then carries into the component's `$props()` reads. A
 * plain object handed to `mount()` and never touched again is exactly why re-opening an
 * already-running add-on by a new deep link used to leave it showing its original props —
 * there was nothing to mutate.
 *
 * A rune file rather than a plain module for the same reason `deepLink.svelte.ts` is one:
 * `$state` needs the Svelte preprocessor, which only runs over `.svelte`/`.svelte.ts` files.
 *
 * Typed with a real `onback` (rather than plain `Record<string, unknown>`) so `mount()`'s
 * own typing stays honest — `boot.ts` overwrites it with the real handler before mounting;
 * this placeholder only exists to make the initial shape satisfy `AppProps`.
 */
export const liveAddOnProps: AppProps & Record<string, unknown> = $state({
  onback: () => {}
});

/**
 * Only the keys the *last call to this function* set — never `onback`, which `boot.ts`
 * assigns directly onto `liveAddOnProps` once and this function must never touch. Tracked
 * separately from `Object.keys(liveAddOnProps)` for exactly that reason: clearing against
 * the live object's own keys would delete `onback` the moment a deep link arrived with no
 * `onback` of its own (it never has one — that key isn't part of any `HydratePayload.props`
 * or push, it's synthesized here).
 */
let previousKeys: string[] = [];

/**
 * Merges a new deep link's props into the live object, and drops whatever the previous
 * one set that the new one doesn't repeat — matching `openApp`'s own shell-side props for
 * an in-process app, which are replaced by a fresh merge on every call rather than
 * accumulated forever (`shell/state/navigation.ts`).
 */
export function setLiveAddOnProps(next: Record<string, unknown>): void {
  for (const key of previousKeys) {
    if (!(key in next)) delete liveAddOnProps[key];
  }
  Object.assign(liveAddOnProps, next);
  previousKeys = Object.keys(next);
}
