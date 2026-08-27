# CLAUDE.md

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
