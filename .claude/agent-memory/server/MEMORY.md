# server agent memory

One file per finding; this index is what loads. Read the file before relying on
its one-line summary. A trap that passed every suite and failed review, or an
oxmysql answer the `Database` stub did not have, goes in its own file and gets a
line here.

- [A new audit action is a schema change](audit-action-is-an-enum.md) —
  `mica_audit_logs.action` is an ENUM; the stub hides it
- [EXPLAIN a new read on a throwaway MariaDB](explain-new-reads-on-throwaway-mariadb.md)
  — recipe, and the two plan traps MICA-307 hit
- [changelog.test wants an index by its own name](changelog-test-blind-to-new-index.md)
  — since MICA-309; still blind on post-baseline tables
- [A type-level test only runs where a tsconfig reads it](type-tests-belong-in-integration.md)
  — server/client tests typecheck against a baseline since MICA-320; shared do
  not
- [serverMessages.test counts a constant key as keyless](server-messages-ratchet-needs-a-literal-key.md)
  — write `key: 'server.…'` literally
- [oxmysql errors carry no errno](oxmysql-errors-carry-no-errno.md) — text only,
  query and parameters embedded, foreign-realm `Error`; use `isDuplicateKey`
- [A row from oxmysql fails a prototype check](oxmysql-rows-are-foreign-realm.md)
  — walk by shape; prove it on a `node:vm` row (MICA-433)
- [A start-up gate must not import schemaSql](start-gate-import-cycle.md) —
  Repository reaches contentCipher; the cycle breaks collection, not tsc
- [A soft delete under a unique key refuses a re-create](soft-delete-under-a-unique-key.md)
  — `uniqueAfterDelete` since MICA-321; a left 1:1 held `pair_key` until
  MICA-342; Blabber mouths until MICA-330
- [A "does not see it" check passes on a wrong filter](negative-check-needs-a-positive-twin.md)
  — pair every negative row or push assertion with a positive one
- [A thread page is the newest window, in send order](thread-page-is-newest-window-in-send-order.md)
  — `messages:get` rows are reversed; not newest first
- [Break-to-prove needs the file in your fence](break-to-prove-needs-the-file-in-fence.md)
  — a harness lane cannot run against edited `server/`; report the gap
- [Outbound HTTP: https only, `micahttp` for the other two](outbound-http-needs-a-player-or-tls.md)
  — the sink needs TLS; webhook URL is a secret; restore unset convars, not `''`
- [micaOS's own start-up passes race in-server scenarios](boot-passes-race-in-server-scenarios.md)
  — prune refused during boot retention; wait on the sweep's lines
- [Splitting a module: re-export only what is imported; no cycle back](splitting-a-module-facade-and-cycles.md)
  — knip fails in-file-only re-exports; a lib helper must not import its service
- [A Lua export's second return value turns its answer into an array](lua-multi-value-returns-arrive-as-arrays.md)
  — `false, 'reason'` arrives as a truthy `[false, 'reason']`; read element 0
- [A Database mock that always rejects hides the overwrite](a-rejecting-db-mock-hides-the-overwrite.md)
  — the save's own read rejects too; fail one read only (MICA-326)
- [A character switch reuses the source and never fires playerDropped](character-switch-keeps-source-state.md)
  — `forgetOnPlayerLoaded`; loads dispatch twice, end-time reads name the new
  character
- [A retried seed reads every status](retried-seed-reads-every-status.md) — soft
  delete keeps the number; MICA-327 retry is process memory
- [A catch spanning a write and its push lies](catch-spanning-a-write-and-its-push.md)
  — answers null for a row that exists; end the try at the write
- [A defaulted column tripped the widen-resume check](additive-column-trips-widen-resume.md)
  — resume skipped the additive pass until MICA-264 fixed it; run
  test:migrations
- [A stolen phone's rows wait for its owner, on purpose](citizen-phone-cache-outlives-the-holder.md)
  — MICA-438: one phone per character; a thief's item opens the thief's own
- [A loop over a registry function asserts nothing](registry-loop-over-a-function-is-empty.md)
  — `Object.entries(REPORTABLE)` is `[]`; assert the count, import every
  declarer
- [The camera's failure fallback is an SVG data URI](camera-fallback-is-an-svg-data-uri.md)
  — a `data` shape rule must admit it; a shared-helper status check breaks other
  services' fixtures
- [A shared wire type change is an SDK contract change](shared-wire-types-are-sdk-surface.md)
  — `UIMessage extends Message`; only `test:unit:web` sees it; run
  test:endpoints too
- [A suite's captured handler is the last one registered](single-slot-handler-capture.md)
  — `playerDropped` has five; an elided import changes which one a test runs
- [pma-voice's call join is unchecked; micaOS undoes it](pma-voice-call-join-is-unchecked.md)
  — MICA-341; read the state bag, no guardNetEvent limit, census fails 9 ways
- [A dedupe before ADD UNIQUE KEY compares as the key does](dedupe-compares-as-the-key-does.md)
  — join on the generated key column; revive refused by NOT NULL columns
- [A new column on an exported table fails privacy.test](new-column-trips-the-privacy-pin.md)
  — `EXPORTED_COLUMNS` pin; only the full server run sees it
- [The framework-number fallback names the old phone](framework-number-fallback-names-the-old-phone.md)
  — `numberOfPhone` since MICA-346; never trust `syncNumber`'s answer, read the
  legacy row after it
- [Privacy.ts cannot import a service that reaches Devices](privacy-cannot-import-a-service.md)
  — `lib/shell` imports Privacy; use `onBeforeSelfServiceDelete`, BFS the edge
- [An unpaired 1:1 holds NULL pair columns](unpaired-thread-needs-coalesce.md) —
  `NOT LIKE` drops it; COALESCE, `<=>` for device_id, a named yes column
  (MICA-349)
- [Assign before the SET that nulls the source](record-before-you-null.md) —
  MariaDB SET is left to right; MICA-350's `absent_number`
- [A race test's gate catches every later write](a-race-gate-catches-every-later-write.md)
  — key the gate on the raced statement, not the table; a new write times out
- [A new reportable service fails ten pinned lists](new-reportable-service-fans-out.md)
  — four outside the fence: two locale catalogs, README, CHANGELOG (MICA-253)
- [Replay captured dbMock SQL on MariaDB](replay-captured-sql-on-mariadb.md) —
  dump calls from a temp suite copy; a fake-world id fails an FK, not the code
- [apply runs migrations before it creates a missing table](apply-runs-migrations-before-creates.md)
  — MICA-388/389; a new migration must check its table exists, or the
  half-created sweep fails
- [The sealed-SQL guard cannot see an interpolated table](sealed-sql-guard-needs-a-literal-table.md)
  — `${TABLE}` hides a body read from encryptedColumns.test; name it literally
- [A DM policy is registered by the app's file](dm-policy-registers-from-the-app.md)
  — a suite may already load Blabber's; re-registering throws (MICA-390)
- [Repository.findAll has no predicate seam](findall-has-no-predicate-seam.md) —
  an override rebuilds the SQL and skips sealed widening; unfiltered `get` spans
  apps
- [A unique key on a permanent parent's id freezes a soft delete](unique-key-on-a-permanent-parent.md)
  — revive refused by NOT NULL rule; use a status-aware generated key (MICA-255)
- [The privacy export reads every owned column, secrets too](privacy-export-reads-hidden-outcomes.md)
  — `private` does not apply there; a live outcome needs `registerExportFilter`
- [node:crypto is a shim; convar names resolve at the call site](node-crypto-shim-and-convar-scan.md)
  — no `randomInt`; a `GetConvar(name)` helper fails convars.test
- [A fresh module graph needs its own phone stub](reset-modules-needs-its-own-phone-stub.md)
  — after `vi.resetModules`, setup.ts stubs the old deviceIdentity; import
  phoneStub fresh
- [A loop through the integration door meets the limiter at 60](door-loops-meet-the-limiter.md)
  — per source and action a minute; steer a draw by the stored point or a convar
- [A unit suite meets the limiter at 60 too](unit-suite-meets-the-limiter.md) —
  passes alone, fails in the file; `__resetRateLimits()` in `beforeEach`
- [A new bridge export read at import breaks other suites' mocks](bridge-mock-lacks-a-new-export.md)
  — reachability.test mocks FrameworkBridge; read it in a function or write it
  out
- [A text's live push is a raw net event](messages-push-is-a-raw-net-event.md) —
  not appEventChannel; the door buffers it as `app: 'net'`
- [Negative sources are not one namespace](negative-sources-are-not-one-namespace.md)
  — `-1` broadcast, Phone's line sources from -2 down, the door's from
  -1,000,000 down
- [A read that opens a sealed column must select `citizenid`](a-read-that-opens-must-select-citizenid.md)
  — the AAD binds it; strip after the open; stub rows must follow the SELECT
- [Set a table aside by copy, not by rename](set-a-table-aside-by-copy-not-rename.md)
  — FK names are schema-unique; a renamed table breaks apply's create
- [Turning off a service's generic CRUD fails three pins](disabling-generic-crud-fans-out.md)
  — deviceServices, uniqueKeyDecisions; genericCrudCallers fails the uncalled
  ones
- [A held core copy has stale data fields](a-held-core-copy-has-stale-data-fields.md)
  — funcrefs on a held `GetCoreObject()` are live, plain fields are a snapshot
- [A core still lists a character after announcing its unload](cores-list-a-character-after-unload.md)
  — forgetting on the unload event is not enough; stop the reseed re-adding it
- [InnoDB reads a blob named anywhere](innodb-reads-a-blob-named-anywhere.md) —
  split the query so the fast half never names the column; measure pages read
- [A whole-reply "no citizenid" check fails on fixtures](no-citizenid-check-fails-on-fixture-strings.md)
  — build handles and URLs that cannot contain the citizenid
- [A switch forgetter must check who took the state](switch-forgetters-check-who-took-the-state.md)
  — key by source and citizenid; make an `atLogout` forgetter idempotent
- [A scanner's string skip must honour escapes](scanner-string-skip-needs-escapes.md)
  — `'it\'s'` read the file inside out and credited a neighbour (MICA-414)
- [One stub phone for everyone hides a device binding](one-stub-phone-hides-a-device-binding.md)
  — give each party its own `device_id`; MICA-431's re-seal passed broken
- [Sealing a column applies its rules to server writes](sealing-a-column-applies-its-rules-server-side.md)
  — `accepts` broke `shareLocation`; `mediumtext` exports as a size
- [Redefine a virtual column by drop and add; pin updated_at](migration-virtual-column-and-fill-traps.md)
  — MODIFY wrote garbage bytes on MariaDB 11; a fill moves updated_at (MICA-432)
- [An erase is not one statement shape for every table](an-erase-is-not-one-statement-shape.md)
  — no `updated_at` on a child, membership is `left_at`, ESX citizenid is 60
- [A row kept but hidden is still writable by its id](a-kept-row-is-still-writable-by-id.md)
  — update, or delete then restore, revived an erased row (MICA-428)
- [A generated column in a revive key turns the revive off silently](a-generated-key-column-silences-revive.md)
  — a create never names it; `reviveAs` (MICA-428)
- [A kept row holds every unique key over a plain column](a-kept-row-holds-every-plain-unique-key.md)
  — the purge used to free it; the participants seat took a second review
- [Rows that hang off an id escape every purge](rows-off-an-id-escape-every-purge.md)
  — `registerDependentRows`; check the actor's account too (MICA-429)
- [A versioned write needs a transaction in every stand-in](versioned-writes-need-a-transaction-stand-in.md)
  — read, guarded transaction, one clock; `versionedWrites(dbMock)` seams the
  read
- [A status write before micaschema apply can blank the row](status-writes-before-apply-blank-rows.md)
  — `sql_mode=''` stores ''; every sweep asks `statusWritesMayRun` first
- [A join onto information_schema.COLUMNS reads every database](information-schema-join-scans-every-database.md)
  — `ON` does not narrow the fill; `UNION ALL` single-table reads instead
- [A read on somebody else's behalf can skip the owner's read](a-foreign-read-skips-the-owners-read.md)
  — MICA-436's `judgeRow` trap, gone in MICA-438; record on every read
- [clearAllMocks keeps a mockReturnValue](clear-all-mocks-keeps-return-values.md)
  — a stale `countItem` 0 passed a "not held" push under break-to-prove
- [A test-schema variant is one long scope](test-schema-variants-are-one-scope.md)
  — a new `const before` collides; `node --check` first; a create check needs a
  fresh citizen
- [A deleted ESX citizenid comes back](deleted-citizenid-comes-back.md) — every
  citizenid-keyed cache and the switch gate miss it; a cold create must ask
  `characterExists` (MICA-440)
