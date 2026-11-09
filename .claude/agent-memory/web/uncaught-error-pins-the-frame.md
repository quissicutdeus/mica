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

For micaOS that is every add-on crash that came from an uncaught error or
rejection. `bootAddOn`'s listeners (`sdk/host/iframe/boot.ts`) and the shell's
fallback in `web/src/shell/addon/srcdoc.ts` forward the error and do not cancel
it. So each crashed frame stays in memory after the crash screen replaces it,
one more per crash. Found during MICA-451 and reported, not fixed: cancelling
also removes the frame's own "Uncaught" console line. A `console.error` of the
stack **string** would keep the line without keeping the frame, since a string
holds no context.

[A document count includes the harness](document-count-includes-the-harness.md)
has the measuring method.
