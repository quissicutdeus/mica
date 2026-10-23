# A versioned write needs a transaction in every suite's stand-in

Since MICA-430, an update that changes a `versioned: true` column goes through
`writeVersioned` (`lib/versions.ts`). Since its review it runs in three steps:

1. **A read** of the rows the predicate names. A row whose versioned columns
   already hold `next` (compared as plaintext, so a sealed value is opened)
   changes nothing, and gets no version.
2. **One `Database.transaction` for the changed rows:**
   `SET @mica_versions_now = NOW()`, then the lock, the `INSERT … SELECT`
   snapshot, and the update. Every statement ends in a guard naming each row by
   id and by its values as read, compared as bytes. A `NOW()` in `where` becomes
   the variable, so an edit window is judged once.
3. **One guarded `Database.update` for the unchanged rows.**

The function returns `{ changed, applied }`. oxmysql's transaction answers only
true or false, so `changed` is read back by `op_key`. A guard that misses
(another edit landed between the read and the write) runs all three once more,
so two edits at once both land, last writer winning. A caller must treat
`applied: false` as not saved, never answer ok (Spark did).

**A suite whose fake `update` "matches nothing" needs `rows` too.** The default
read always finds a row, so a write the fake refuses looks like a lost race and
is retried, which doubles the suite's statement counts. Return `[]`, or the
suite's own world, from `rows`, as conversationPrivacy does.

`server/__tests__/versionedWrites.ts` teaches a suite's stand-in this path:

- The first read goes through a seam (`__setVersionReadForTests`), not
  `dbMock.query`, so a suite's queued `query` once-values stay its own. By
  default it answers one row whose every column is `BEFORE_THE_EDIT`, so
  everything counts as changed. Pass `rows` to read the suite's own world
  (spark.test does).
- The write reaches the suite's own `update` fake with the guard stripped
  (`withoutGuard`), so that fake's regexes still match.
- A suite that calls `vi.resetModules` loads a fresh `lib/versions`. Install
  `standInRead` there with that module's own setter, as blabberEditWindow does.

Install it in `beforeEach`, after anything that resets mocks.

Traps on MariaDB:

- **Qualify every column.** Unqualified columns resolve to the inner table of a
  `where` with an `EXISTS` over members; `writeVersioned` takes an `alias`.
- **A source table needs `citizenid`.** The snapshot reads its owner from it.
- **A fixture's blank field gives a scrub nothing to version.** The
  privacy-erase case in test:schema expected a version of blanking an already
  blank name, a no-op version. Give the fixture a value to blank.
- **Change the snapshot's shape with care.** `micacrypt` walks the snapshots
  (`walkSnapshots`), and a key is never called retirable while one uses it.

Related: [[a-race-gate-catches-every-later-write]],
[[replay-captured-sql-on-mariadb]], [[status-writes-before-apply-blank-rows]].
