# A store that reads `window` at module scope breaks node-environment suites

`web/src/lib/isBrowser.ts` is `() => !window.invokeNative` — unguarded, which is
correct everywhere it actually runs. The trap is that `web/`'s Vitest project
does **not** use jsdom everywhere: a good number of suites run in the node
environment, where `window` is undefined, and such a suite fails on **import**
rather than on an assertion.

Two module graphs are wide enough that adding an `isBrowser()` call in module
scope anywhere upstream of them takes suites down:

- `shell/state/registry.ts` — imported by `sdk/manifest.test.ts`,
  `sdk/permissions.test.ts`, `sdk/host/useKeybinds.test.ts`,
  `sdk/host/useTimer.test.ts`, `shell/state/appDrawer.test.ts`,
  `shell/state/navigation.test.ts`, `shell/state/shade.test.ts`,
  `shell/state/sheets.test.ts`. Eight suites, all node.
- `shell/state/searchResults.ts` — its own suite is node, and the module's
  docstring is explicit that it is pure and testable without standing up
  services. `services/admin.ts` sits behind an `isBrowser()` at module scope
  (`writable(isBrowser())`), so importing anything that reaches it from
  `searchResults.ts` fails the same way.

Symptom either way:

```text
ReferenceError: window is not defined
 ❯ isBrowser src/lib/isBrowser.ts:1:32
```

Two fixes, and which is right depends on the module:

1. **A pure rule gets its own file with no store imports.**
   `lib/appVisibility.ts` holds the app-visibility predicate;
   `shell/state/appVisibility.ts` holds the same rule wired to stores.
   `searchResults.ts` imports the first. Do not "fix" a pure module's suite by
   stamping `// @vitest-environment jsdom` on it — that discards the property
   the file was written for.
2. **A store module that genuinely must be imported by `registry.ts` guards the
   read**: `typeof window !== 'undefined' && isBrowser()`. See
   `services/capabilities.ts`. Its own suite then needs
   `// @vitest-environment jsdom` at the top, because a node run answers "not a
   browser" whatever `isBrowser` is mocked to — that is the guard working, not a
   bug.

Mocking `../lib/isBrowser` with `vi.doMock` does **not** rescue a
node-environment suite when the guard is a raw `window` deref: the module under
test still evaluates `window.invokeNative` before the mock's return value
matters.

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
