# `derived_inert` only fires for a rune `$derived` in a `.svelte` file

MICA-266 investigated a `https://svelte.dev/e/derived_inert` warning seen in
game alongside a fresh-character boot. The trigger, from
`node_modules/.../svelte/src/internal/client/reactivity/deriveds.js`'s
`execute_derived`: it fires when something reads a `Derived` signal whose owning
effect (`derived.parent`) carries the `DESTROYED` or `INERT` flag. That flag
lives on the _rune_ implementation only.

`svelte/store`'s own `derived()` (used throughout this repo per AGENTS.md §4 —
see `shell/state/locale.ts`'s `effectiveLocale`, `shell/state/ownerConfig.ts`'s
`disabledAppIds`) compiles a `$store` read to `store_get()` in
`internal/client/reactivity/store.js`, which is backed by a plain
`mutable_source` (a `$state`-shaped Source), not a `Derived`. It never touches
`execute_derived` and cannot produce this warning. Only a `$derived(...)` rune
written directly inside a `.svelte` `<script>` block can. A grep for `$derived(`
narrows the search a lot more than one for "stores fed by a given piece of boot
state."

In this codebase the only home-lifecycle component using the rune is
`web/src/shell/AppDrawer.svelte` (`visibleApps`, `results`, `groupLabel` — the
last is a `$derived` that returns a function, called later as
`groupLabel(result.group)` in the template). `Launcher.svelte`, `Dock.svelte`
and `Search.svelte` use none.

Real destruction points for a home-lifecycle component, in `Shell.svelte`:
navigating away from Home destroys Home, Dock, Search and AppDrawer entirely
(unlike a resident app, which only goes `display:none` + `inert`); an app's own
`<svelte:boundary>` catching a render error does too (`ErrorBoundary.svelte`'s
own comment: "Svelte destroys the main effect the moment it catches"); and
closing the phone tears down everything inside it at once.

Tried and failed to reproduce empirically via Playwright against the mock
transport: opening/closing the App Drawer (plain grid and with a live search
query) around a `rehydrateShell` message, switching apps mid-rehydrate, closing
and reopening the phone across it, and an unwaited/racy version of all of the
above (no `await` between actions, `rehydrateShell` fired twice). None produced
the warning. The mechanism above is solid (verified in Svelte's own source), but
the exact interleaving that trips it — apparently a promise/timer callback
closing over a `$derived` read after its component's destroy — did not show up
under Playwright's event-loop timing. If this comes up again, look for an app
crash via the boundary (a real render throw, not just a slow fetch) coinciding
with a store refill still in flight, rather than plain navigation races.
