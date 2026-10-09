# server agent memory

One file per finding; this index is what loads. Read the file before relying on
its one-line summary. A trap that passed every suite and failed review, or an
oxmysql answer the `Database` stub did not have, goes in its own file and gets a
line here.

- [A new audit action is a schema change](audit-action-is-an-enum.md) —
  `mica_audit_logs.action` is an ENUM; the stub hides it
- [EXPLAIN a new read on a throwaway MariaDB](explain-new-reads-on-throwaway-mariadb.md)
  — recipe, and the two plan traps MICA-307 hit
- [changelog.test wants an index by its own name](changelog-test-blind-to-new-index.md)
  — since MICA-309; still blind on post-baseline tables
- [A type-level test only runs where a tsconfig reads it](type-tests-belong-in-integration.md)
  — server, client and shared tests are never typechecked; `integration/` is
- [serverMessages.test counts a constant key as keyless](server-messages-ratchet-needs-a-literal-key.md)
  — write `key: 'server.…'` literally
- [oxmysql errors carry no errno](oxmysql-errors-carry-no-errno.md) — text only,
  query and parameters embedded; classify and log the last line only
- [A start-up gate must not import schemaSql](start-gate-import-cycle.md) —
  Repository reaches contentCipher; the cycle breaks collection, not tsc
- [A soft delete under a unique key refuses a re-create](soft-delete-under-a-unique-key.md)
  — `uniqueAfterDelete` since MICA-321; Blabber mouths still wedge
- [A "does not see it" check passes on a wrong filter](negative-check-needs-a-positive-twin.md)
  — pair every negative row or push assertion with a positive one
- [A thread page is the newest window, in send order](thread-page-is-newest-window-in-send-order.md)
  — `messages:get` rows are reversed; not newest first
- [Break-to-prove needs the file in your fence](break-to-prove-needs-the-file-in-fence.md)
  — a harness lane cannot run against edited `server/`; report the gap
- [Outbound HTTP: https only, `micahttp` for the other two](outbound-http-needs-a-player-or-tls.md)
  — the sink needs TLS; webhook URL is a secret; restore unset convars, not `''`
- [micaOS's own start-up passes race in-server scenarios](boot-passes-race-in-server-scenarios.md)
  — prune refused during boot retention; wait on the sweep's lines
- [The mica_devices row is one of the walked tables](phones-row-is-one-of-the-walked-tables.md)
  — it moves last, as the durable "unfinished" mark; MICA-319
- [Splitting a module: re-export only what is imported; no cycle back](splitting-a-module-facade-and-cycles.md)
  — knip fails in-file-only re-exports; a lib helper must not import its service
- [A Lua export's second return value turns its answer into an array](lua-multi-value-returns-arrive-as-arrays.md)
  — `false, 'reason'` arrives as a truthy `[false, 'reason']`; read element 0
- [A Database mock that always rejects hides the overwrite](a-rejecting-db-mock-hides-the-overwrite.md)
  — the save's own read rejects too; fail one read only (MICA-326)
- [A character switch reuses the source and never fires playerDropped](character-switch-keeps-source-state.md)
  — source-keyed maps hold the previous character; forget on load
- [A retried seed reads every status](retried-seed-reads-every-status.md) — soft
  delete keeps the number; MICA-327 retry is process memory
- [A catch spanning a write and its push lies](catch-spanning-a-write-and-its-push.md)
  — answers null for a row that exists; end the try at the write
- [A defaulted column tripped the widen-resume check](additive-column-trips-widen-resume.md)
  — resume skipped the additive pass until MICA-264 fixed it; run
  test:migrations
- [A citizen-keyed phone cache outlives a handover](citizen-phone-cache-outlives-the-holder.md)
  — check against `holderNow`; owner chose a stashed phone keeps receiving
- [A loop over a registry function asserts nothing](registry-loop-over-a-function-is-empty.md)
  — `Object.entries(REPORTABLE)` is `[]`; assert the count, import every
  declarer
- [The camera's failure fallback is an SVG data URI](camera-fallback-is-an-svg-data-uri.md)
  — a `data` shape rule must admit it; a shared-helper status check breaks other
  services' fixtures
- [A shared wire type change is an SDK contract change](shared-wire-types-are-sdk-surface.md)
  — `UIMessage extends Message`; only `test:unit:web` sees it; run
  test:endpoints too
- [A suite's captured handler is the last one registered](single-slot-handler-capture.md)
  — `playerDropped` has five; an elided import changes which one a test runs
- [pma-voice's call join is unchecked; micaOS undoes it](pma-voice-call-join-is-unchecked.md)
  — MICA-341; read the state bag, no guardNetEvent limit, census fails 9 ways
