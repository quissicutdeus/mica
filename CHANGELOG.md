# Changelog

What changed for the people who run gPhone on a server, and what they have to do
about it. This is the file to read before pulling a new version.

It is written for a server owner, not for a contributor. The question it answers
is "will this update break my server, and does it need anything from me" — a
schema change, a new convar, a renamed command, a changed export. Work that
never reaches an owner (a refactor, a test, a CI fix, a UI polish pass) is
deliberately absent. `git log` and the auto-generated notes on each GitHub
release are the contributor-facing record and remain so.

**Entries are dated, not versioned, and that is deliberate.** Every push to
`main` cuts a CalVer tag of the form `vYYYY.MM.DD.N`, where `N` counts commits
on that date rather than identifying a release — eleven tags were cut on
2026-08-27 alone, several of them one commit apart. An owner moving from
`v2026.08.27.46` to `v2026.08.27.67` needs one story, not eleven. So the date is
the unit here, and every tag stamped with a given date carries that date's
entry.

**A release with no entry means there was nothing for an owner to do**, not that
nobody wrote it down. That silence is checked rather than assumed:
`server/__tests__/changelog.test.ts` fails the build when either of the two
changes that put `gphoneschema apply` in front of an owner lands without being
named here — a versioned migration in `server/migrations/`, and a column or key
added to a `defineService` declaration. The additive half compares the
declarations against a frozen list of the schema as it stood on 2026-08-29, so
anything the tables have grown since then has to be written down before the
build goes green. What it still cannot see is listed at the top of that file.

Entries are hand-written. See MICA-72 for why a generated one was rejected.

## Unreleased

### Action required

**If you run a third-party add-on that draws reactions, check it against this
release.** `ReactionBar`, the SDK component an add-on draws a reaction row with,
changed shape: it now takes `summary` and `ontoggle` in place of `counts`,
`mine`, `onreact` and `onunreact`. An add-on written against the old props will
not render its reactions until its author updates it. Nothing that ships with
the phone is affected (MICA-98).

**If you have recently upgraded qb-core or qbx_core, watch your server console
for `[FrameworkBridge]` errors after this update.** gPhone now refuses a money
move its framework did not confirm with a plain `true`, and refuses to spend
against a balance that did not come back as a number — see the first entry under
Fixed. On a framework whose money calls answer the way they always have, nothing
changes. On one whose contract has moved, players will find a payment refused
where it previously appeared to succeed, and the console will name the call that
answered oddly. That is the safer of the two failures, but it is visible, and
the log line is what tells you which resource to look at.

**If you run ESX, a player has one phone — not one per character.** gPhone keys
every row it owns on one identity column, `citizenid`, and on ESX that column
holds the player's own identifier — the license or steam string the framework
knows them by. On qbx_core and qb-core it holds the character's id, so each
character carries its own contacts, messages and gallery. The asymmetry is
deliberate rather than a gap: ESX has no character system to hang a separate
phone on, and giving gPhone a second notion of identity would have put the
question into every ownership check in the resource instead of one place
(MICA-150).

**Moving an existing server between ESX and a qb core re-keys every phone, and
gPhone ships no migration for it.** The rows written under the old identity stay
in the tables, but nobody resolves to them any more, so players arrive to empty
phones rather than to merged ones — and if changing framework means dropping and
recreating the framework's own `players` table, the foreign keys described in
the README take every one of those rows with it. Neither direction is a
conversion. Plan a framework switch as a data migration you write, or as a
deliberate reset your players are told about.

Nothing else. No versioned migration has landed and no table has gained a
column, so nothing here needs `gphoneschema apply`. Every convar below defaults
to the behaviour a server already had, so an update that sets none of them
changes nothing for your players.

### Added

- Proximity music, which lets a phone play out loud to the people standing
  around it, is bounded by two new convars: `gphone_music_range` for how far it
  carries, and `gphone_music_max_nearby` for how many broadcasters one listener
  is told about at once (MICA-111).
- `gphone_camera_quality` sets how hard a photo is squeezed before it is stored,
  for an owner trading picture quality against database size.
- A Bluetooth proximity share now reaches at most five phones, nearest first,
  set by the new `gphone_bluetooth_max_nearby` convar. It was previously
  everyone in range, however many that was, and a photo drop writes each of them
  a full copy of the photo. Raise it if your server's idea of "nearby" is a
  whole club; the ceiling is 16 (MICA-115).
- A photo larger than 4MB is refused rather than stored. The column holds 16MB
  and nothing checked against anything smaller, so a modified client could fill
  `gphone_media` far faster than any camera can. Nothing the phone's own camera
  produces comes close to the cap — `gphone_camera_quality` is still the knob
  for how big stored photos actually get (MICA-116).
- Each player's photo library now has a ceiling, set by the new
  `gphone_media_quota_mb` convar and defaulting to 64MiB — roughly 150 to 200
  captures. Over it, a photo is refused with a message that says the library is
  full; deleting something frees the room immediately. A proximity share checks
  each recipient too and skips anyone with no space, so nobody is pushed over
  their ceiling by somebody else's gesture (MICA-71).
- `gphone_media_retention` deletes stored media older than a number of days you
  choose. **It is off by default and it deletes rows permanently**, so it
  changes nothing until you set it. It runs at resource start and on the new
  `gphonemedia prune`, which is console-only for the same reason
  `gphoneschema apply` is. `gphonemedia` with no argument still only reports
  (MICA-71).
- A deleted character's photos are cleaned up rather than left behind. The table
  already cascades off `players`, and now a sweep at every resource start also
  removes media whose owner no longer exists — for installs whose table predates
  that constraint — while a deletion script of your own can trigger
  `gphone:server:media:characterDeleted` with a citizenid to reclaim the space
  at once (MICA-71).

- `gphone_hodlr_trade_max` caps what a single Hodlr buy or sell can be worth,
  defaulting to 50,000 — the same number and the same shape as
  `gphone_bank_transfer_max`, which was until now the only value cap on the
  phone. Nothing bounded a trade before, so one request could convert a whole
  bank balance into coin or a whole holding back into money (MICA-130).

On the question behind all of that: **photos stay base64 in MySQL.** A FiveM
resource has no static file host it can safely write to, one database backup
still restores the whole phone, and CEF renders a data URI without a second
fetch — so the fix for a table that grew forever is bounds on it, not a
different place to put it. The day gPhone stores real video that answer changes,
and that will be its own release note.

Their defaults, and which of them need `setr` rather than `set`, are in the
README's [Configuration](README.md#configuration) section — the distinction
matters, because the two that the game client reads are silently ignored unless
they are replicated.

### Fixed

- **A framework that stops answering money calls the way it used to can no
  longer create currency.** gPhone asks your framework to debit and credit
  players, and it believed whatever came back. If a qb-core or qbx_core release
  made `RemoveMoney` asynchronous — an ordinary thing for a resource to do — the
  pending answer read as a completed debit, and the person being paid was
  credited whether or not the payer was ever charged. Same shape for a balance:
  a lookup that answered with anything but a number compared as "can afford it",
  and the spend went through. gPhone pins the FiveM runtime exactly and cannot
  pin your framework, so this was one upgrade away on any server, with no
  attacker involved and no error to see — the first sign would have been an
  economy that no longer balanced. Every one of those branches now refuses
  instead: only a literal `true` counts as money having moved, only a finite
  number counts as a balance, and anything else is logged as a
  `[FrameworkBridge]` error naming the call that answered oddly. Bank transfers
  and Hodlr trades are the two places you would notice (MICA-133).
- **Hodlr's coin price survives a restart.** It was module state that opened at
  500 every time the resource started, while the holdings it values are a real
  database column that came straight back — so every restart re-valued every
  holding at a constant anyone can read in the source, and buying under it was a
  risk-free bet on the next restart. The price is now restored from the newest
  row of the price history that was already being recorded for the chart. There
  is nothing to run: the table and its rows already exist, and a brand-new
  install — no history and nobody holding a coin — still opens at 500. A restart
  no longer resets your economy's coin (MICA-130).
- **Hodlr refuses to guess a price it cannot recover.** If the price history is
  empty while players still hold coin, that is a lost history rather than a new
  server, and reopening at 500 would re-value every holding at the number the
  original exploit was built on. The market stays closed instead and says so in
  the console and on the phone, retrying every 30 seconds, so restoring
  `gphone_hodlr_price_history` from a backup reopens it with no restart. The
  hourly pruning sweep also now keeps the newest row whatever its age — it is
  the price, not a chart point, and a server that had been down longer than the
  retention window used to delete it (MICA-130).
- **A database that stops answering mid-restore no longer wedges the market
  shut.** `restart oxmysql` while Hodlr was reading its price left a promise
  that never resolved, and the market stayed closed for the life of the resource
  — every trade refused, chart flat, only `restart gphone` to recover. An
  unanswered read is now abandoned after a minute and retried (MICA-130).
- **The coin no longer drifts downward on its own.** Its random walk multiplied
  the price by a symmetric percentage each tick, which decays by construction —
  simulated below its opening price about 60% of the time at every horizon, with
  a median of 172 after 72 hours of uptime. The step is now taken in log space
  and pulled gently back toward 500, so a long-running server's coin stays in a
  tradeable band instead of grinding toward the floor. **Expect prices on an
  established server to look different after this update**: a coin that had
  drifted far below 500 will climb back toward it over the following hours
  (MICA-130).
- **The price floor is no longer a free bet.** At the floor of 50 a downward
  tick rounded back to 50 and was discarded, so a holder sitting there had no
  downside at all. Both boundaries now turn a step around rather than swallowing
  it (MICA-130).

## 2026-08-27

This file starts here. Tags before this date carry only GitHub's auto-generated
commit lists, which is the record they were released with; they are not
backfilled into prose that nobody wrote at the time.

### Action required

None. No versioned migration exists in `server/migrations/` yet, so no update to
date has required `gphoneschema apply` for a rename, a retype or a drop.

### Added

- Every convar gPhone reads is now documented in the README's
  [Configuration](README.md#configuration) section, with the defaults as they
  are written in the code — so a server that sets none of them behaves exactly
  as that block shows. Six of them had previously been documented nowhere an
  owner would look. A build check now fails when a convar is added without an
  entry, so the list cannot drift back out of date (MICA-73).

### Notes for anyone installing or updating

- The schema is [`gphone.sql`](gphone.sql), imported by hand. Every statement is
  `CREATE TABLE IF NOT EXISTS`, so re-importing an existing database is
  harmless.
- gPhone applies no schema change on its own. `gphoneschema` in the server
  console reports where the database differs from the code and changes nothing;
  `gphoneschema apply` — console only — applies pending versioned migrations and
  then the safe additive half of the difference.
- When an entry above says a migration landed, run `gphoneschema apply` from the
  server console after updating the resource and before letting players on.
