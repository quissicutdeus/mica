# micaOS's own start-up passes race an in-server scenario

A scenario that prunes or plants orphans soon after boot runs beside micaOS's
own work, and passes or fails on timing. The qbx orphan-sweep scenario passed
for weeks, then failed on hoth (run 37707937593, MICA-322 follow-up) with
`[micamedia] a retention prune of mica_media is already running`.

Three passes start at resource start, after `whenSchemaReady`:

- **Retention** (`lib/contentRetention.ts`, `startRetentionSchedule`): one
  `runRetention()` over every table, then every 6 h. While it is on a table,
  `isRetentionRunning` is true and `micamedia prune` **refuses by design**, not
  a bug to serialise. Use `runMediaPrune` (`integration/lib/mediaPrune.ts`),
  which asks again under `eventually` and fails naming the refusals.
- **The whole-phone orphan sweep** (`lib/shell.ts`): prints
  `[mica] orphan sweep starting` and `finished:` (or `failed:`) whatever it
  found. `bootOrphanSweepEnded` (`integration/lib/bootSweep.ts`) waits on those.
- **The media-only orphan sweep** (`services/Media.ts` start hook): since
  MICA-332 prints `[micamedia] orphan sweep starting` and `finished:` (or
  `failed:`), and holds a running flag; `micamedia prune` refuses while it runs
  with `an orphan sweep of mica_media is already running`, a second refusal
  `runMediaPrune` did not know about when MICA-332 landed.
  `bootMediaOrphanSweepEnded` waits on it. Its `skipped at start` line is not an
  end.

The runner's `sleep(3_000)` after `micaReady` is not a guarantee: none of these
passes is bounded by it. The tap registers when `mica-integration` starts, after
`ensure mica`, and micaOS prints only after an async schema check, so the lines
are expected in the tap, but that ordering is inferred, not proven.

Tests: `server/__tests__/integrationMediaPrune.test.ts` covers both helpers.
