# Replay what a suite's Database mock captured, on a throwaway MariaDB

The cheapest way to prove every statement a new service emits, exactly as the
code builds it (MICA-253, 2026-10-16):

1. Copy the suite to a temporary `server/__tests__/zz<callsign>Dump.test.ts`
   with an `afterEach` that appends every `dbMock.{query,insert,update,single}`
   call (`[sql, params]`) as one JSON line to a scratchpad file. Run it, then
   delete the copy — it must never be staged.
2. Start `mariadb:12.3` with `docker run -d --rm`, the port published on
   `127.0.0.1`, and `MARIADB_ROOT_PASSWORD` / `MARIADB_DATABASE=mica` set. A
   scratchpad `.mjs` loads `mysql2` through
   `createRequire('<repo>/package.json')`, creates the stub `players` table,
   runs `mica.sql` with `multipleStatements`, seeds the suite's world, and runs
   each distinct statement with its params.

The trap: an insert keyed on an id the **fake** world handed out (a child row's
`post_id` of 100 when MariaDB's auto-increment said 13) fails its foreign key.
That is the replay, not the code — rerun that one statement with the real id
before calling it a finding. Semantics the fake only imitates (an
`UPDATE ... JOIN` ownership predicate) are worth asking MariaDB directly with
crafted rows, since the fake's answer is whatever the test author believed. See
[[explain-new-reads-on-throwaway-mariadb]] for plans rather than syntax.
