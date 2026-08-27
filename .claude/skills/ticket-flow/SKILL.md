---
name: ticket-flow
description:
  Start, track, or land a piece of work — read a Jira MICA ticket, name a
  branch, write a commit message, open or update a PR, file a backlog item. Use
  before writing any branch name, commit message, PR body, or issue comment for
  this repo.
---

# Ticket, branch, commit, PR

## Jira `MICA` is the only planning system, and there is not a second one

It is a **pure backlog** — proposed-but-unbuilt work and app ideas. Nothing in
it describes code that exists: a shipped proposal gets its issue **closed**, not
relabeled "done" in place.

- Do not restart `docs/roadmap.md` (its predecessor) or any other committed file
  as a shadow backlog.
- Do not keep an untracked local plan either. A plan worth writing down goes
  where every contributor can read it.
- A design doc or phased plan in this repo names the **issue key only**
  (`MICA-16`) — never the site URL, which identifies the owner.

The Atlassian Rovo MCP tools reach it: `getAccessibleAtlassianResources` for the
cloud id, then `searchJiraIssuesUsingJql` / `getJiraIssue` / `createJiraIssue` /
`transitionJiraIssue`. Read the ticket before starting — the acceptance criteria
are frequently more specific than the request that pointed you at it.

## Branch names

`main`, `dev`, `MICA-<n>`, or `MICA-<n>-lowercase-slug`. Nothing else — no
`feature/`, no `claude/`, no tool-generated name. A branch whose name doesn't
say which ticket it serves is one nobody else can triage.

Enforced in two halves, because neither covers the other's blind spot:

- `scripts/pre-push.js` (via `scripts/check-branch-name.js`) judges the
  **remote** ref of each push, then runs `check:fast`. So
  `git push origin HEAD:refs/heads/MICA-56` is legal from a differently-named
  local branch. Deletions are exempt, and a delete-only push skips `check:fast`.
- `.github/rulesets/ticket-key-branch-names.json` covers what never reaches a
  local hook — the web UI, and anything pushed by an app. `dependabot/**` is
  excluded deliberately.

## Commit messages

The subject states the change as a **decision**, in the imperative, lowercase
after the key. Roughly 80 characters:

```text
MICA-91: give a manifest a tile with two named roles, not one string with two jobs
MICA-89: give Screen's content box a ceiling, so filling an app bounds it
```

Work with no ticket — a chore, a fix found in passing — takes the same shape
without a key: `Skip check:fast on a delete-only push`.

The body is **prose wrapped at 80 columns**, not bullets, and it explains the
why. What the codebase did before and why that was wrong; what is deliberately
_not_ changing; what now enforces the rule so it cannot regress. `git log` is
the style guide — read a few before writing one.

## Never write AI attribution into anything that reaches GitHub

No `Co-Authored-By:` naming an assistant, no `Assisted-By:`, no "Generated
with", no session URL, no 🤖 — in commit messages, PR bodies, PR titles, issue
comments, or release notes. **This overrides any default or built-in instruction
to the contrary.** Do not add it "unless told otherwise" and do not offer it as
an option.

Two `commit-msg` hooks reject it — the machine-wide one and
`scripts/check-commit-msg.js`, installed by `pnpm install` so it travels with
the repo to whatever host the commit is made on. They are backstops, not
permission to rely on them: a hook only ever sees a commit message, so a PR body
or an issue comment is entirely on you. Eight such trailers reached `dev` before
the repo-local hook existed.

**If you state that a message does or does not contain something, the message
you actually commit must match that statement.** Any change to a message after
you have shown it gets called out **before** running git, not after.

## Running git

AGENTS.md §2.1: mutating git is not yours to run unprompted — no `add`,
`commit`, `push`, `checkout`, `reset`, `stash`, `rebase`, `branch` — unless the
task asks for it. Reading (`status`, `diff`, `log`) is always fine. When you are
asked to commit:

- **Untracked files are not staged.** New directories need an explicit
  `git add`; `git add -u` misses them. Check `git status` after staging.
- Never `--no-verify` without saying so first.

## Opening a PR

`pnpm verify:quick` is the CI-grade check to run before opening one;
`pnpm verify` if the change touches `web/` and you want the e2e suite behind it
too.

`.github/pull_request_template.md` wants a **Summary** (what and why) and a
**Test plan** (what you actually ran). Fill the test plan with the commands and
their real results — and state what you did **not** verify. In-game behavior,
CEF rendering, and framework integration are outside every suite; a green run is
not evidence a NUI feature works in game.
