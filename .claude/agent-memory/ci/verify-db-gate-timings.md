# verify's real-MariaDB gates: timings and flags

Measured 2026-11-09 on the desktop, warm `mariadb:11` image: `test:schema` 47s,
`test:endpoints` 9s, `test:migrations` 300s. `pnpm verify` runs the first two
when Docker answers (or `MICA_DB_*` is set) and prints NOT RUN otherwise;
migrations needs `--migrations`. CI's `verify` job passes `--no-db` because its
`schema` and `endpoints` jobs already run them.

**How to apply:** a new real-DB gate goes in `DB_GATES` in
`scripts/lib/db-gates.js`, and `server/__tests__/verifyDbGates.test.ts` holds
the wiring. Re-measure before moving migrations out of opt-in.
