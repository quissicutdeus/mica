# A document-count spec must never enter an add-on frame

A spec that counts live documents (`Performance.getMetrics` `Documents` after
`HeapProfiler.collectGarbage`) must **never enter an add-on frame**: no
`frameLocator`, `contentFrame()`, or evaluate/locator inside one.

**Why:** Playwright leaves its InjectedScript in every frame it evaluates in,
held by a CDP console handle. In Chromium 103 (cef-floor) each frame later
evicted then keeps its document: +1 document, ~2.5 MB per eviction. My first
MICA-451 spec went red 19 -> 21 on exactly that and measured Playwright, not the
shell; modern Chromium did not show it. Hunter's heap snapshots found the shell
releases frames fully. See also the web agent's
`document-count-includes-the-harness.md`.

**How to apply:** wait on the outer page only.
`web/e2e/addon-eviction-leak.spec.ts` marks each `<iframe>` loaded with a
capture-phase `load` listener in `addInitScript` (attribute, never a held
reference: a held iframe pins its document too), and waits on
`iframe[data-app][data-loaded]`. Take the baseline after every add-on has been
opened once, since each add-on's SVG images count as documents. To prove such a
guard fires without touching `web/src`, temporarily `page.evaluate` a stash of
the iframes' `contentWindow`s onto `window`: 19 -> 25 in both projects. Remove
it after.
