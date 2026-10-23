# A join onto information_schema.COLUMNS reads every database

MariaDB narrows an `information_schema` fill only by conditions in that table's
own `WHERE`. Conditions in a `LEFT JOIN ... ON` clause do not count, even
single-table ones like `c.TABLE_SCHEMA = DATABASE()`. Measured on 12.3 for
`micastorage` (2026-10-23), next to 400 tables that were not micaOS's:

- `TABLES t LEFT JOIN COLUMNS c ON ...`: EXPLAIN says `Scanned all databases` on
  `c`. 563 table definitions opened, about 30 ms.
- A correlated subquery on `COLUMNS` per row: 24,181 definitions, 1.25 s.
- `UNION ALL` of the two single-table reads, each with its own `WHERE`:
  `Scanned 1 database` on both, 50 tables opened, under 5 ms.

`TABLE_NAME LIKE 'mica|_%' ESCAPE '|'` in a `WHERE` does filter before the open.
A `TABLES` read for `DATA_LENGTH` opens only the `mica_` tables.

A `UNION ALL` of `GROUP BY status` counts over tables with different collations
(`latin1` next to `utf8mb4_bin`) does not fail on 11.8 or 12.3. MariaDB drops
the collation instead of raising "Illegal mix".

How to check it: `SHOW SESSION STATUS` `Opened_table_definitions` before and
after, with `FLUSH TABLES` first, on a throwaway MariaDB that also holds noise
tables in a second database. See [[explain-new-reads-on-throwaway-mariadb]].
