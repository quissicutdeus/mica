# A throwing store subscriber wedges every store

Svelte's `writable.set` queues each subscriber call on one module-level
`subscriber_queue`, shared by every store in the bundle
(`svelte/src/store/shared/index.js`). It clears that queue only after the loop
finishes. If a subscriber throws, the queue keeps its entries, so every later
`set`, on any store, sees a non-empty queue and never runs it. The whole phone
stops updating until reload. A `try` around the `subscribe` call does not help:
it covers the first call and none of the later ones.

`IframeHostServer` hit this when `postMessage` threw `DataCloneError` on a
function in a pushed value (a manifest's `icon` component, a toast's `onClick`).
Fixed on 2026-10-19. Every push now goes through `toCloneable` and runs inside
its own `try`.

Two things for tests:

- The wedge outlives the test that caused it. In the same file, unrelated tests
  that `set` a store then fail too, so a burst of failures may come from one
  throw.
- A fake guest window that just pushes messages into an array cannot throw. In
  `IframeHostServer.test.ts` it calls `structuredClone(m)`, which Node provides
  in vitest's jsdom environment, so a value that cannot be cloned fails there
  the way it does in the browser.

A related trap: `safe_not_equal` counts every object as changed. A derived store
that calls `set` with the same object notifies again. A store scoped for
privacy, such as `lifecycle.currentApp` or the toasts in `phoneNotification`,
has to skip the `set` itself when nothing changed. Otherwise every change in
another app reaches the frame as an identical push, and that alone shows when
another app did something.
