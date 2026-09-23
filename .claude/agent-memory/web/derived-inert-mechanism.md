# `derived_inert` only fires for a rune `$derived` in a `.svelte` file

MICA-266 investigated a `https://svelte.dev/e/derived_inert` warning seen in
game alongside a fresh-character boot. Round one of this ticket wrongly said
`web/src/shell/AppDrawer.svelte` was the only shell component using the rune —
`grep -rln '\$derived' web/src sdk --include='*.svelte'` actually lists 81
files. Grep before claiming a search was exhaustive.

## The exact trigger, from Svelte's own source

`execute_derived` in
`node_modules/.../svelte/src/internal/client/reactivity/deriveds.js`:

```js
if (
  !is_destroying_effect &&
  parent !== null &&
  derived.v !== UNINITIALIZED &&
  (parent.f & (DESTROYED | INERT)) !== 0
) {
  w.derived_inert();
  return derived.v; // the *old* value, not recomputed
}
```

Two things this means in practice:

- **`execute_derived` only runs when the derived is dirty** (`runtime.js`'s
  `get()` calls `update_derived` only `if (is_dirty(derived))`). Simply reading
  a `$derived` variable from a destroyed component's closure is silent if
  nothing changed the derived's dependencies since it was last computed — the
  read just returns the cached value via a fast path that never reaches the
  INERT check. **You need dirty AND destroyed/inert at the same instant.**
- **A `$derived` fed by a plain `svelte/store`** (`$someStore`, compiled to
  `store_get()` in `internal/client/reactivity/store.js`, backed by a
  `mutable_source`, not a `Derived`) **cannot itself warn** — only a
  `$derived(...)` rune can. But it can still go dirty and drag a dependent
  `$derived` into the trap, _except_: `store_get()` unsubscribes from the store
  the moment the component is torn down (checks `IS_UNMOUNTED`). So a store
  update sent **after** a component is fully destroyed never reaches its
  deriveds at all — there is no dirtying to exploit. Confirmed empirically: see
  the Trade.svelte test below, where `portfolioStore.set(...)` after
  `@testing-library/svelte`'s `unmount()` provably does nothing to the destroyed
  component's `$derived`.

## Where the warning is actually reachable

Given the two points above, the trigger needs the read to happen **during**
destruction, not after it's complete — the INERT window, not the DESTROYED one.
Two known routes in this codebase:

1. **A component with `out:`/bidirectional `transition:...|global`** stays
   mounted (DOM present, store subscriptions still live) for the duration of the
   transition while its effect is flagged INERT, not yet DESTROYED.
   `PhoneFrame.svelte` and `TabletFrame.svelte` both have
   `transition:fly|global={{ ... duration: 500 }}` on their root — closing the
   phone (`Shell.svelte`'s `{#if visible}` going false) keeps _everything_
   inside it (every resident app, Home, AppDrawer, ToastHost) alive-but-INERT
   for 500ms. A store update landing in that window (a `rehydrateShell`-driven
   refill is exactly this) can dirty a derived that a still-attached DOM event
   handler then reads. Not reproduced empirically — jsdom/Playwright's event
   loop did not land a hit inside this specific 500ms window in several tries.
2. **An async continuation (or an unguarded timer/subscribe callback) that reads
   one of the component's own `$derived` values after resuming**, when the
   component can be destroyed before that continuation runs. This one doesn't
   need the transition window at all if the dirtying source is something other
   than an auto-subscribed store (a component-local `$state`, or another
   `$derived`) — but in practice most of this codebase's `$derived`s bottom out
   in a store, so point 1's severed-subscription behavior usually protects it
   _unless_ the read happens before full destroy.

## Two real hits found by static audit (round two), both fixed

- **`web/src/apps/hodlr/components/Trade.svelte`**: `submit()`'s `run()` body
  awaited `buy`/`sell`, then passed `maxSell` to `tradeFailureMessage` on a
  refusal, so it read the `maxSell` `$derived` _after_ the await. `Trade` is an
  `{:else if}` branch in `hodlr/index.svelte` — `onback()` (Cancel) destroys it
  immediately, and nothing disables Cancel while a trade is `busy`. Fixed by
  snapshotting `const holdingAtSubmit = maxSell` before the await, mirroring
  `sdk/ui/NowPlayingCard.svelte`'s pre-existing `live` boolean guard pattern
  (that file is the one example in the codebase that already does this right).
- **`web/src/apps/settings/panes/License.svelte`**: `copySource`'s `catch`
  branch re-read `sourceUrl` (`$derived`) after
  `await navigator.clipboard.writeText(...)` rejected. `License` is an
  `{:else if pane === 'license'}` branch — navigating back destroys it. Fixed
  the same way (snapshot into a local `const` before the `try`).

Both fixes are justified by Svelte's source-level semantics regardless of
whether the exact warning could be reproduced under test — see the
`Trade.test.ts` note above for why a `$derived`-over-`$store` case specifically
resists a jsdom/testing-library repro. The safer, testable regression coverage
for `Trade.svelte` ended up being behavioral (the error message must name the
holding as of Confirm, not as of the server's answer) rather than a console-spy
assertion, in `web/src/apps/hodlr/components/Trade.test.ts`.

## What was audited and found clean

All 18 `web/src/shell/*.svelte` files and all 13 `sdk/ui/*.svelte` files (Rex's
stated priority) were checked by hand for: an async handler reading its own
`$derived` after an `await`; a bare `setTimeout`/`setInterval`/
`requestAnimationFrame` not cleared on destroy; and a `.subscribe()` not torn
down via `$effect`'s cleanup or `onDestroy`. Findings:

- `useTimer()`'s `after`/`every` (`sdk/host/useTimer.ts`,
  `web/src/host/facets/timer.ts`) are safe by construction — `onAppUnmount`
  (literally `onDestroy`) clears every pending timer, so a scheduled callback
  never starts after the owning app is torn down. `camera/index.svelte`'s
  `after(...)`-wrapped photo-capture flow, which reads `isLandscape`/
  `currentViewfinderImage`, is fine.
- `AppDrawer.svelte`'s and `NotificationShade.svelte`'s own `setTimeout`s are
  both cleaned up via the `$effect`'s own returned cleanup function — safe.
- `sdk/ui/NowPlayingCard.svelte`'s `dominantColorFrom(url).then(...)` already
  uses the `let live = true; ... return () => { live = false }` guard — the
  correct pattern, worth copying rather than reinventing.
- `web/src/apps/blabber/index.svelte` and
  `web/src/apps/blabber/components/TaggedFeed.svelte` have a top-level (not
  `$effect`-wrapped)
  `taggedBlabs.hasMore.subscribe(...)`/`feed.hasMore.subscribe(...)` that is
  never unsubscribed — a real memory leak, but the callback only writes a
  `$state`, never reads a `$derived`, so it cannot produce this warning. Out of
  scope for this ticket; flagged here for whoever next touches Blabber.
