# A document count includes the harness and every SVG image

MICA-451 chased "102 documents, 34 MB" after a session, and a growth on every
add-on eviction. Neither was the shell. A heap snapshot named both causes.

- **Playwright pins every frame it evaluates in.** `contentFrame()`,
  `frameLocator` or `frame.waitForFunction` puts Playwright's `InjectedScript`
  in that frame, held by a `(Global handles) / DevTools console` handle. Each
  evicted add-on frame then keeps its document, its template document and about
  2.5 MB of heap. With the same build and scenario, 4 add-ons opened twice each:
  29 documents and 22.2 MB when the harness touched the frames, 19 and 9.4 MB
  over bare CDP, 19 and 11.5 MB under Playwright that never touched them.
  Doubling the evictions left the last two flat.
- **It is Chromium 103's inspector, so the e2e projects disagree.** In 103 any
  CDP remote object held in a frame's context pins that frame after removal:
  five plain frames each holding one `Runtime.evaluate('document')` object
  stayed at 6 documents, and dropped to 1 on `Runtime.releaseObjectGroup` or
  when that session closed. Wrecker's spec, which enters the frames, went 19 to
  21 under `cef-floor` and stayed at 19 under modern Chromium. Chrome 156 ran
  sandboxed `srcdoc` frames out of process (the page session saw no frame
  contexts), so its page-level count cannot show this at all.
- **Trace snapshots enter every frame too, even when the spec never does.** With
  `trace: 'retain-on-failure'` (the config default), the DOM snapshotter
  (`frameSnapshotStreamer`) runs in each frame around every action. In a frame
  the shell is just removing, it throws
  `Cannot read properties of undefined (reading 'DOCUMENT_FRAGMENT_NODE')`, and
  in 103 that `TypeError` is held by a `DevTools console` handle. That pins the
  frame. It only races under parallel load: MICA-469's crash spec failed 19 of
  30 at 8 workers with tracing, and passed 30 of 30 with `--trace off` and 30 of
  30 with `trace: { mode: 'retain-on-failure', snapshots: false }`.
- **Each SVG image is a document.** Blink renders one in its own page, so it
  counts as an `XMLDocument` and a frame in `Performance.getMetrics`, held from
  C++ roots with no JS retainer. Bounded by the distinct images used.
- **Each document using `<template>` brings a second `HTMLDocument`**, its
  template content owner. A live add-on frame counts 2.

So, before calling a document count a leak:

- Measure over bare CDP (`Runtime.evaluate` in the main world,
  `Input.dispatchMouseEvent`), or under Playwright with no frame access.
- Show that it grows with the number of evictions, not just that it is high.
- Take `HeapProfiler.takeHeapSnapshot` and classify the native nodes:
  `HTMLDocument`, `XMLDocument`, `detachedness`. Then BFS from the root with the
  `DevTools console` handles excluded. Whatever is still reachable has a real
  retainer.

A frame that died of an uncaught error is a separate, real pin:
[An uncaught error keeps a removed frame alive](uncaught-error-pins-the-frame.md).
