# Any directory under `web/src/apps/` counts as an app

During the MICA-410 to 420 wave, a lane created an empty
`web/src/apps/.claude/agent-memory/web/` by writing memory relative to its
working directory. `sdk/appContract.test.ts` ("covers every app in apps/")
listed `.claude` as an app missing from `APPS`, and every a11y test broke with
it. Git does not track empty directories, so `git status` showed nothing.

**Why:** the app scans read the directory listing, dot-directories included, not
the git index. A stray folder is enough, with no files in it.

**How to apply:** write memory only under the absolute path
`/opt/fivem/server-data/vendor/mica/.claude/agent-memory/<type>/`, never a
relative `.claude/...`. When appContract names an app nobody added, run
`ls -a web/src/apps` before suspecting the test.
