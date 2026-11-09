# A taint scan counts Repository.delete and guard verdicts as state

A static scan that follows a client payload into module state (MICA-468,
`server/__tests__/clientAuthoritative.test.ts`) has three traps, and each one
changed its answer:

- `.delete(` belongs to a collection **and** to a repository
  (`messageRepo.delete` is SQL). Count a remover only on a binding the module
  also fills with `set`/`add`/`push`.
- Device state is mostly stored by branching (`if (!enabled) return;` and then
  `speakers.set(src, …)`), so taint that only follows values misses
  `phone:speaker`. Also taint the writes a payload condition decides, including
  those after an early exit.
- `if (!guarded) return;` (the `guardNetEvent` verdict) is not a decision.
  Counting it makes every write in every raw handler the client's. Only writes
  keyed by the caller's connection are device state; the rest are caches.

Each of these flipped the derived set between "nothing" and "dozens", and the
suite pins its size. Before trusting a "lands nowhere", run a fixture with five
handlers: explicit, branched, early-exit, verdict-only and server-value. Check
that exactly the first three land. That is a positive twin, as in
`negative-check-needs-a-positive-twin.md`.
