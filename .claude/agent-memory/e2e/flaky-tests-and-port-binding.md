# End-to-end test traps: ports, timers, and flakiness

Learnings and hard-won constraints from `web/e2e/` and its support helpers.

## Playwright serves on port 4173, and port collisions on WSL2 are invisible

`web/playwright.config.ts` runs `vite preview --strictPort` on port **4173**
(distinct from Vite dev on 5173).

When port 4173 is already held, Vite fails to bind immediately. On WSL2, the
process holding port 4173 may be running on the Windows host side, which `ss` or
`netstat` inside the Linux guest does not reveal.

- Do **not** change the port in `playwright.config.ts` or add random retry
  ports. That hides an environment collision rather than fixing it.
- If port 4173 is held, report the collision and stop.

## Fixed timeouts race animations under load

Never use `page.waitForTimeout(N)` to wait for an action or animation to settle:

- A fixed 500ms wait against a long-press or CSS transition passes when run
  alone, but reliably races and flakes under parallel CPU load in CI.
- Always wait on an observable condition: an element appearing, an attribute
  changing, or a settled state class.
- `playwright.config.ts` sets `retries: 0` by design — a single flake is a red
  deploy.

## Proving new regression tests

When adding a regression spec:

1. Revert the fix temporarily.
2. Run the spec to prove it goes red.
3. Restore the fix and verify it passes.
4. Run `--repeat-each=5` to verify it is flake-free before concluding.
