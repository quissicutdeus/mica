# An inlined dynamic import keeps every export

Found on MICA-449 (2026-11-08), rolldown 1.2.16 under Vite 8.

In a build with `output.codeSplitting: false` — every add-on bundle,
`web/vite.addon.config.ts` and the template's copy — any `import('@mica/sdk')`
is emitted as `Promise.resolve().then(() => (init_addon(), addon_exports))`,
where `addon_exports = __exportAll({...})` lists **every** barrel export. Each
export is then live, so `treeshake.moduleSideEffects` cannot drop anything
behind it: `renderMarkdown` kept marked and DOMPurify, and the rest of the SDK
stayed too. Blabber, Glimpse and Spark do this inside `lazyBadge` in their
manifests, and lost ~200 KB each once the frame entry stopped importing the
manifest at all: it now hands `bootAddOn` `{ id }` read from the manifest text,
in both `vite.addon.config.ts` and the template. Anything that puts a manifest
module back into an add-on graph (an app importing its own `./manifest`) brings
the whole SDK back with it.

The import's shape does not matter. Destructured `await import()`,
`.then(({ x }) => …)`, `.then((m) => m.x)` and `(await import()).x` all kept the
whole namespace inlined. With code splitting on, all four shook down to the
names used, even when the barrel was also imported statically. So the same
manifest is harmless in the shell build and costly in an add-on.

Find what keeps a module alive by building that one add-on unminified with
`--sourcemap --minify false --outDir <scratch>` and grepping for `__exportAll(`.
Do not reason from the source.

See [[addon-components-ship-in-the-shell]].
