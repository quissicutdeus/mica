# An uncaught error keeps a removed frame alive

Chromium 103, a sandboxed `srcdoc` frame, and no DevTools session attached while
it ran (attached only after the removal, to count). Five frames, then all five
removed, then a forced GC:

| What the frame did                           | Documents after removal |
| -------------------------------------------- | ----------------------- |
| nothing                                      | 1                       |
| classic `throw`, module `throw`, parse error | 6                       |
| `Promise.reject` left unhandled              | 6                       |
| any of those, with its event cancelled       | 1                       |
| cancelled, then `console.error` of the stack | 1                       |

The snapshot path is `(Global handles)` → the exception → its constructor → the
frame's native context → `Window` → the document, so the whole frame heap stays
too. Cancelling the `error` or `unhandledrejection` event is what lets it go.

For micaOS that was every add-on crash. MICA-469 fixed it where the shell writes
every frame's first script, `FRAME_ERROR_LISTENERS` in
`web/src/shell/addon/srcdoc.ts`. It cancels both events, still forwards them,
and prints the stack once as a string, since a string holds no context.
`bootAddOn`'s own listeners need no change: the shell's run first in every frame
it builds.

Two consequences to know before touching it:

- **Never log the error object in a frame.** `console.error(error)` keeps the
  object for the console and pins the frame again; log its `stack` string.
- **A cancelled error raises no Playwright `pageerror`.** The e2e fixture's
  "uncaught page error fails the test" no longer sees add-on frames. Their crash
  still reaches the page console twice: as the frame's `Uncaught …` line and as
  the shell's `add-on '<id>' crashed:` line.

[A document count includes the harness](document-count-includes-the-harness.md)
has the measuring method.
