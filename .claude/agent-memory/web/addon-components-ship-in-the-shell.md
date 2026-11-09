# An add-on's components ship in the shell build

Found on MICA-449 (2026-11-08).

`web/src/shell/state/registry.ts` lazily globs `apps/*/index.svelte` and
`apps/*/tablet.svelte` for **every** app. It only calls the entries for core
apps, but `core` is a runtime check the bundler cannot fold, so `dist/web`
carries lazy `notes-*.js`, `blabber-*.js`, etc. They are never loaded in game,
since an add-on runs from `addons/<id>.js` in a frame.

They still count for tree-shaking. Whatever those dead chunks import from
`@mica/sdk` stays live in the shell, and because the barrel is static it lands
on the **startup** path unless a manual chunk plus `moduleSideEffects: false`
keeps it lazy. That is how `renderMarkdown`, called only by Notes, put marked
and DOMPurify in the modulepreloaded `vendor` chunk.

Before claiming "the shell never uses X", grep the unminified shell build
(`vite build --minify false --outDir <scratch>`) for X and look at which chunk
imports it.

See [[inlined-dynamic-import-keeps-whole-namespace]].
