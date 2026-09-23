# The sdk persisted registries have no unregister; keep disposables out

`sdk/host/seam/persistedRegistry.ts`'s
`registerPersistedRehydrate`/`registerPersistedReset` are correct exactly
because every caller is a `usePersisted` store: one per key, created once at
module scope, alive for the life of the page. Nothing ever needs to leave that
registry, so it doesn't support leaving.

An add-on's `IframeHostServer` is a different shape entirely — resident once
opened (like an in-process app), but the _server object itself_ is disposed and
rebuilt on every Restart and on uninstall (`AddOnFrame.svelte`'s effect
explicitly tears down and rebuilds it, see MICA-90/196 comments there).
Registering a per-instance closure into a permanent, unregisterable Set on every
hydrate leaks one stale entry per restart for the life of the session — worse,
if you guard the registration with an idempotency flag scoped to _hello_ rather
than to the _server instance_ (mirroring `stopTheme`'s `if (!stopTheme)` pattern
without noticing it resets on every reload), you get a fresh leaked entry per
reload too.

The fix used for MICA-287 (a live add-on frame's storage cache going stale
across a character switch): a second, purpose-built registry in
`web/src/host/settingsSync.ts`
(`registerAddOnStoragePush`/`pushStorageToAddOns`) that _does_ return an
unregister function, called from `IframeHostServer.ts`'s `forgetGuest()` — the
same place that already tears down `stopTheme`. Same idempotent-registration
shape as the theme subscription (register once per guest document in
`hydrate()`, drop in `forgetGuest()`), but backed by something that can actually
be removed.

General rule: before wiring a per-open-object subscription into any of this
codebase's "registered once, run forever" registries (this one,
`persistedRegistry.ts`, anything shaped like it), check whether the object doing
the registering is itself resident for the page's whole life or disposable
within the session. If disposable, it needs its own registry with a real
unregister, not the permanent one — and that new registry has to live outside
`sdk/` if the disposable object (an add-on frame server, in this case) is on the
`web/src` side of the wall, since `sdk/` isn't yours to add capacity to on a
`web`-lane task.

See [[callor-default-hides-failure]] for the sibling MICA-287 finding.
