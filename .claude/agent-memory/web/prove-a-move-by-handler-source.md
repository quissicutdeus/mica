# Prove a code move by comparing handler source, not just keys

MICA-323 split the 2,868-line mock registry into `web/src/nui/mocks/services/`.
"Same keys" alone would pass if a handler had been pasted into the wrong closure
(a `let` counter duplicated in two files, say). The proof that held up:

- Copy the old file next to the new ones as `parityBefore.tmp.ts` with one line
  appended exporting its private object, and import both in a throwaway Vitest
  test. Delete both temp files after.
- Compare `Object.keys` sorted, then `String(handler)` per key. Vitest rewrites
  imported names to `__vite_ssr_import_N__.name` and `(0, __vite_ssr_...)`
  calls, and the old file (one module) and new files (many) differ there, so
  strip both forms and collapse whitespace before comparing. It is
  `__vite_ssr_import_`, not `__vi_import_`.
- Vitest prints nothing for a passing test's `console.log` in this repo, so get
  a count out by asserting it against `-1` once and reading the failure.

Also: knip 6 resolves `import.meta.glob`, so files reached only through a glob
are not reported unused. And the repo's `routes.test.ts` reads mock files as
text (root Vitest has no Vite), so a glob-collected directory needs a fixed
declaration shape that a regex can find. The web-side test holds that shape too.
