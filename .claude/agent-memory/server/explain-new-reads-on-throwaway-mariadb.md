# EXPLAIN a new read on a throwaway MariaDB

No unit suite executes SQL, and the `Database` stub hides plan problems.
`scripts/test-schema.js` is the CI harness, but it belongs to the `ci` lane. To
check a new statement from the server lane, run a disposable database by hand.
The `mariadb:11` image is already on the box:

```sh
docker run -d --rm --name "$CALLSIGN-sql" \
    -e MARIADB_ROOT_PASSWORD=x -e MARIADB_DATABASE=mica mariadb:11
```

- `mica.sql` needs a stub `players (citizenid varchar(50) PRIMARY KEY)` first,
  because its opening guard selects from qb's table.
- A recursive CTE makes volume. MariaDB's limit is `max_recursive_iterations`,
  not MySQL's `cte_max_recursion_depth`.
- `ANALYZE TABLE` before `EXPLAIN`. On a dozen rows the planner picks PRIMARY
  for everything and the plan says nothing.

What it found on MICA-307 (2026-10-05):

- A newest-row-per-thread subquery ordered by `id DESC` cannot ride
  `conversation_status_created` and filesorts each thread. Ordering by
  `created_at DESC, id DESC` reads one index entry and does not sort.
- Line threads always carry the `ext:` key in `participant_b`
  (`openLineThread`). No index covers that column, and `pair_key_unique` cannot,
  because LEAST/GREATEST flips the order by phone id. A read by line scans every
  active thread through `status`.

Do not pipe or `sed` a script whose name contains `test-` in a Bash call. The
repo's guard hook reads it as a gate and blocks the whole call, including any
edit in the same command. Read it with the Read tool.
