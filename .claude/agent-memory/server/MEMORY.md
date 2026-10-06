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
