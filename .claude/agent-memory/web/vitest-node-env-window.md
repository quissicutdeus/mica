# `isBrowser()` is safe in a node suite; `typeof window` is not

`isBrowser` lives in `sdk/lib/isBrowser.ts` and is exported from `@mica/sdk`.
Since MICA-177 it is built on `hostRuntime()`, which answers `'browser'`,
`'cef'` or `'headless'`, and `'headless'` is what a node-environment suite gets:
no `window` at all. `isBrowser()` is `false` there, so a module-scope
`writable(isBrowser())` (`services/admin.ts`) no longer throws on import, and
the old `ReferenceError: window is not defined` from a store graph is gone. This
note used to describe that trap and its two fixes; both are retired.

What is still true:

- **`false` under node means "not a browser tab", not "this is CEF".** A node
  test that reaches a `!isBrowser()` branch takes the CEF path. That is why
  `web/src/nui/transport.ts` asks `hostRuntime()` and refuses a headless runtime
  out loud instead of picking a transport. If a suite needs the browser answer,
  give it `// @vitest-environment jsdom`; mocking `isBrowser` is the other way.
- **A raw `window.` read at module scope is still a trap.** Only `isBrowser()`
  and `hostRuntime()` are guarded. Guard anything else with `typeof window`.
- **A pure rule still gets its own file.** `web/src/lib/phone/appVisibility.ts`
  holds the visibility predicate with no stores behind it;
  `web/src/shell/state/appVisibility.ts` wires the same rule to stores.
  `shell/state/searchResults.ts` stays a pure module with a node suite. Do not
  stamp jsdom on a pure module's suite to quiet it.

## Related: an "ask once per session" latch is a character-switch bug

`services/admin.ts` carried `let asked = false`, never cleared. `pushRehydrate`
on a character switch runs `resetBootstrapState()` + `bootstrapStores(true)`
(`shell/nuiMessages.ts`), which calls `refreshAdmin()` again — and the latch
swallowed it, so the new character inherited the previous one's icon visibility.
The CEF page never unloads in game, so "once per session" meant once per
resource start, not once per player.

De-duplicate on the **in-flight promise** instead, nulled in `finally`.
Concurrent boot callers still cost one request, and a later call re-reads. Any
new server-answered store in `services/` should do the same.

## Where a "which apps exist" answer has to be asked

`bootstrapStores` is gated on the phone being _opened_ (`Shell.svelte`'s
`$effect(() => { if (visible) bootstrapStores(); })`). Anything whose answer
decides whether an icon is drawn at all must additionally be kicked from an
`onMount` at page load — that is resource start, with the phone still closed —
or the launcher paints without the app and adds it a beat later in front of the
player. `hydrateSettings`, `refreshPasscodeStatus`, `loadRemoteAppConfig` and
now `refreshCapabilities` all do this, each with the reasoning in a comment
above its own `onMount`.
