# Rows that hang off an id escape every purge

A purge finds rows by their owner column. A follow, a block, a reaction, an ear,
a swipe or a match carries only an account or profile id, so no purge ever
reaches it.

- **Before MICA-428** the parent's delete cascaded onto these rows.
- **After MICA-428** the parent was only erased, so the rows stayed live. An
  erased account's follows still counted on everyone it followed, and its
  reactions stayed in every total. No suite saw this, because nothing counted
  after a purge.

MICA-429 added `registerDependentRows` (`sweep/dependents.ts`). In the same run
as the parent, it erases every row naming an erased parent in any of the listed
columns, so both ends of a two-ended row are covered. The test that catches a
missing one is test:endpoints' privacy flow: it reads player 2's follower count
and reaction totals through the real handlers before and after player 1's
delete. With the registration taken out, the counts stay `[1, 1, {👍: 1}]`.

The review then found two more holes, fixed in `sweep/dependents.ts`:

- **A parent can become erased outside the purge.** `restoreTarget` puts a
  takedown back to `erased`. It now erases the parent's dependents itself, and
  the orphan sweep's `eraseStrandedDependents` catches whatever is left.
- **`col IN (SELECT …)` cannot use an index on MariaDB before 11.1**, and under
  REPEATABLE READ it locked whole tables. Instead, read a page of erased parent
  ids first, then send `col IN (?, …)` with literal ids, once per column.
  EXPLAIN shows a `range` scan on each FK index.

Erasing a block held against an erased account opens one more path. A caller
check that reads only the caller's own row lets a profile left live on an erased
account act again. Spark's `requireActiveProfile` read only `mica_spark`.

Before adding a parent with rows that hang off its id, ask two questions:

- Does each such row reach a purge?
- Does every actor check also ask about the account behind the row?

Related: [[an-erase-is-not-one-statement-shape]],
[[a-kept-row-holds-every-plain-unique-key]].
