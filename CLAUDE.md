# CLAUDE.md

> **Do not delete this file, and do not remove the `@AGENTS.md` line below.**
> Claude Code reads `CLAUDE.md`; a root `AGENTS.md` is inert unless something
> imports it. Deleting this file, or that one line, switches off every rule in
> the repo at once — silently, with no error and nothing in any suite to notice.
> This file looks like a two-line stub that only points at another file. That is
> exactly what makes it load-bearing.

The rules for this repo live in [`AGENTS.md`](AGENTS.md), one file for every
assistant. It is imported below rather than restated here, so the two can never
drift apart.

@AGENTS.md

Conditional detail is packaged as skills in `.claude/skills/`, loaded only when
the work calls for it:

- `nui-endpoint` — before adding or changing a `fetchNui` call, a route, a
  server action, or a server-to-app push. A missing layer fails **silently in
  game** while passing every suite.
- `cef-css` — before writing any CSS, colour, or layout under `web/`. FiveM's
  CEF is Chromium 103.
- `mica-service` — before declaring a service, changing a column, or writing a
  migration. Pulls in `docs/schema-and-services.md`.
- `ticket-flow` — before writing a branch name, commit message, PR body, or
  issue comment.

Work that is farmed out to a subagent picks an **agent type** from
`.claude/agents/`, so the rules for that kind of work arrive with the agent
rather than being pasted into each prompt. **Each is named for the directory its
work lives in** — or, for the two that own no directory, for the verb the lead
already uses — so routing needs no translation step and a pane title says what
is running:

- `server` — `server/`: a service, table, column, index, migration or net event.
  Carries §2.9 and the `defineService` rules.
- `client` — `client/`: the client half of a service, a NUI callback, the prop
  and camera, device state, the framework bridge, a client export. Carries
  "nothing here is authority" and "no suite can start the game".
- `web` — `web/src/`: any component, app, CSS, utility class or layout. Carries
  the Chromium 103 floor and the `Screen` sizing rules.
- `sdk` — `sdk/`: a hook, a UI primitive, the permission table, the manifest
  contract. Carries the rule that everything here is public and breaks add-ons
  nobody in this repo can see.
- `docs` — `docs/`, README, this file. Carries "write from the code, not from
  the docs".
- `e2e` — `web/e2e/`: Playwright specs and flake. Carries `retries: 0` and what
  e2e cannot prove.
- `ci` — `.github/`, hooks, shell, `scripts/`, `build/`, the deploy. Carries the
  rule that a check which stays silent when it cannot run reads as a pass.
- `review` — a diff, read-only: findings with a file and a line, and nothing
  changed. Carries the list of what survives the suites.
- `verify` — the gates, once, over the integrated tree: exit codes as they were,
  counts reconciled. Carries "a summary line is a claim".

Pick the one whose directory the work lives in. `shared/` travels with the lane
that owns the handler or the consumer driving the change, and `general-purpose`
is the right answer when a task genuinely spans several. The first seven write
code; `review` and `verify` are the two the lead spawns after the lanes report
and before it commits.

The name is the routing key and stays boring. Each agent's `description:` keeps
the reason it works the way it does — that is where a name from the setting
earns its place, rather than in an identifier you have to translate first.
`server/__tests__/assistantConfig.test.ts` holds this list to what is on disk.
