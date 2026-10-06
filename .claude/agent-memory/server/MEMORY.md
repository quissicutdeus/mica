# server agent memory

One file per finding; this index is what loads. Read the file before relying on
its one-line summary. A trap that passed every suite and failed review, or an
oxmysql answer the `Database` stub did not have, goes in its own file and gets a
line here.

- [A new audit action is a schema change](audit-action-is-an-enum.md) —
  `mica_audit_logs.action` is an ENUM; the stub hides it
- [EXPLAIN a new read on a throwaway MariaDB](explain-new-reads-on-throwaway-mariadb.md)
  — recipe, and the two plan traps MICA-307 hit
- [changelog.test is blind to a new index](changelog-test-blind-to-new-index.md)
  — green on a known table; report the entry anyway
