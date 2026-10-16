# InnoDB reads a blob named anywhere in the statement

A `SUM(COALESCE(stored_bytes, LENGTH(data)))` over `mica_media` still read every
off-page `data` value, even for rows where `stored_bytes` was set and the
`LENGTH` was never reached: 1802 pages against 8 measured on MariaDB 11. Naming
the column is enough to make InnoDB fetch it.

**How to apply:** to avoid reading a blob, split the query so the fast half does
not name the column at all (`WHERE stored_bytes IS NOT NULL` summing only
`stored_bytes`, plus a second half for the rest), and measure it: compare
`Innodb_pages_read` on a cold buffer pool with and without the blob. Found on
MICA-358.
