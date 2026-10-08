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
  query embedded; classify on the last line
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
- [The mica_phones row is one of the walked tables](phones-row-is-one-of-the-walked-tables.md)
  — it moves last, as the durable "unfinished" mark; MICA-319
