# A new defaulted column trips the widen-resume migration check

`scripts/test-migrations.js`'s `runWidenResume` builds a database from the
fixture frozen before migration 0004, runs `runPendingMigrations()` only, and
compares the whole schema against `complete.schema`, which the uninterrupted
widen case built with the additive pass (`SchemaMigrator.apply()`) as well. Any
column declared after the fixture froze exists in the second and not the first,
so the check fails on a column that `micaschema apply` adds correctly.

Found on MICA-264: `mica_devices.kind` was the only difference.
`test:unit:server`, `test:schema` and `typecheck` were all green; only
`pnpm test:migrations` saw it, which needs a local MariaDB. The fix belongs in
the harness, and the ci lane made it there on MICA-264: the resume case now runs
the additive pass before comparing, as the other widen cases do.

So a widen-resume failure after that fix is a real schema difference again.
Still run `pnpm test:migrations` when a declaration gains a column or index;
only it sees this, and it needs a local MariaDB.
