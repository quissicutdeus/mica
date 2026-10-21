# MICA-407 axe scan eats the 30s budget on cef-floor

- The streamer-on "messages thread" a11y test timed out (30s) once in a full
  `pnpm verify`, on cef-floor only. The trace showed every step fast except
  axe's in-page `runPartial` (18s) plus `finishRun` (~5s): the scan itself, not
  a wait on the app.
- Cost is DOM size. The surface loaded the whole thread (three "Load older
  messages" clicks). Alone it took 13.6s on cef-floor at HEAD, 14.4s after the
  MICA-407 bubble change (+0.8s, so not the bubble), 18s with the whole
  a11y.spec.ts running, 37s under the full suite's 16 workers.
- Fix was in the spec: one click is enough to draw the first attachment slot
  (8.7s alone, 10.7s under file load). Timeouts untouched.
- When an axe test is slow, read the trace's call titles and stack files first
  (`test.trace` in the zip, `before`/`after` events); a slow
  `AxeBuilder.analyze` frame means shrink the DOM, not the waits.
