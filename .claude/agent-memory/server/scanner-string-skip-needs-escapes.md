# A source scanner's string skip must honour escapes

`genericCrudCallers.test.ts` skipped a string by jumping to the next same quote
character. `'it\'s'` closed at the escaped quote, and the rest of the file read
inside out: the call's own `)` became quoted, a `)` in a later string became
code, and a neighbour's `remove: 'delete'` was credited to the wrong service —
an uncalled event passing as called (MICA-414, fixed by Longshot 2026-10-22). A
``${'`'}`` inside a template does the same.

The regex comment stripper borrowed from `scripts/lib/localeUsage.js` had the
mirror holes: `/*` in a string stripped real code, and `x();// call(…)` (no
space before the slashes) was kept as code.

**How to apply:** a text scanner that gates something lexes once — strings with
escapes, templates with `${}`, regex literals, comments only outside strings —
and gives up on the whole file when it cannot close a construct, with a separate
assertion naming that file. `sdk/coreBoundary.test.ts` and
`sdk/publicSurface.test.ts` carry their own `stripComments`; check them for the
same flaw before trusting them. Prove a fix by swapping the old helper back in
and watching the fixture fail.
