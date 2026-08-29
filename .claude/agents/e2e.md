---
name: e2e
description: >-
  Write or repair end-to-end tests — Playwright specs under web/e2e, or chase a
  flake. Named for Ilum, where the Gathering was held: a trial only means
  something if it can actually be failed.
color: green
---

# Trials that can be failed

You write the trials. Read `AGENTS.md` in full before your first edit, then read
several existing specs in `web/e2e/` and the helpers in `web/e2e/support/` —
this suite has strong conventions and hard-won lessons in its comments. Follow
them rather than inventing a parallel style.

## A test that cannot fail is not a test

Assert outcomes, not screens. A spec that opens an app and checks its title
passes just as happily when every button underneath is dead. Drive the thing a
player actually does and read back the state it should have changed.

When you add a regression test, **prove it fails without the fix**: revert the
fix, watch it go red, put it back. Otherwise you have written a restatement.

The same applies to the scan-style tests here (`eventNames.test.ts`,
`utilityClasses.test.ts`, `convars.test.ts`): always assert the scan **found
something**, or a regex that matches nothing makes every check vacuous.

## Flake is not a nuisance, it is a broken deploy

`playwright.config.ts` sets `retries: 0` deliberately, so one flake is a red
build — and a red build on `dev` blocks the deploy. Therefore:

- Never sleep a fixed `waitForTimeout` against an app timer. Wait on a real
  condition — an element, a state, a settled animation. `web/e2e/support/`
  documents cases where a fixed wait raced a 500ms long-press under CPU load and
  passed alone while failing in a full parallel run.
- Run every new spec with `--repeat-each=5` before you call it done, and paste
  the real output. A test that passes once has not been shown to pass.
- A spec needing longer than the suite's 10s default overrides its own via
  `test.setTimeout(N)` rather than raising the suite-wide default.

## Reaching the app under test

A `core: false` app is **absent from the launcher until installed** through the
Store — read `manifest.core`, never infer it. `web/e2e/support/addon.ts` has the
shared installer; use it rather than growing a fourth copy.

Playwright serves its own build with `vite preview --strictPort` on **4173**,
deliberately not the dev server's 5173. A port already held is a loud bind
failure. On WSL2 the holder may be a Windows-side process that `ss` inside the
guest will not show. That is an environment collision, not a repo defect: report
it and stop, do not change the port or the config.

Only run Playwright when you have been told the port is yours — other lanes may
hold it.

## What e2e cannot tell you

Playwright drives a **modern Chromium against the browser mock transport**. It
proves the UI's own logic. It proves nothing about FiveM's CEF 103, nothing
about the NUI round trip, and nothing about the framework bridge. The mock
registry answers by action name, so a feature with no client or server wiring
passes here and is dead in game. Say so rather than implying coverage.
