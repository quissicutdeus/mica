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
- `gphone-service` — before declaring a service, changing a column, or writing a
  migration. Pulls in `docs/schema-and-services.md`.
- `ticket-flow` — before writing a branch name, commit message, PR body, or
  issue comment.

Work that is farmed out to a subagent picks an **agent type** from
`.claude/agents/`, so the rules for that kind of work arrive with the agent
rather than being pasted into each prompt. Each is named for something old in
the setting, on the grounds that a name you remember is a name you route to:

- `massassi` — the phone's UI: any component, CSS, utility class or layout under
  `web/src`. Carries the Chromium 103 floor and the `Screen` sizing rules.
- `rakata` — the server half: a service, table, column, index, migration or net
  event. Carries §2.9 and the `defineService` rules.
- `dwartii` — CI, workflows, the deploy, git hooks, shell. Carries the rule that
  a check which stays silent when it cannot run reads as a pass.
- `whills` — documentation. Carries "write from the code, not from the docs".
- `ilum` — end-to-end tests and flake. Carries `retries: 0` and what e2e cannot
  prove.

Pick the one whose directory the work lives in; `general-purpose` is the right
answer when a task genuinely spans several.
