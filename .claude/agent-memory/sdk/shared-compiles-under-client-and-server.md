# shared/ compiles under the game targets too

`client/tsconfig.json` and `server/tsconfig.json` both include `../shared/**/*`
with `lib: es2021`/`es2023` and only the FiveM types. So a new `shared/` file is
typechecked three times, and two of those programs have **no `URL`, no DOM, no
Node globals** — `pnpm typecheck` fails client and server on a bare `URL` while
sdk and web pass (MICA-311, `shared/addonDev.ts`).

Do not add `/// <reference lib="dom" />`: a lib reference applies to the whole
program, handing all of `client/` and `server/` the DOM. `shared/addonDev.ts`
describes the URL members it reads as a structural `ParsedUrl` interface and
reads the constructor off `globalThis`, refusing every input where there is
none.

A second trap in the same place: `vitest run ../sdk` also matches
`sdk/node_modules/@mica/shared/*.test.ts` through the workspace symlink, so
shared tests run twice and the file count exceeds what is on disk (88 for 82 on
2026-10-06). Reconcile with `vitest list --filesOnly` before calling a count
wrong.
