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
`server/__tests__/changelog.test.ts` fails the build when a versioned migration
lands in `server/migrations/` without being named here, so the one change that
always demands action — running `gphoneschema apply` — cannot ship unannounced.

Entries are hand-written. See MICA-72 for why a generated one was rejected.

## Unreleased

Nothing to do, but two limits now exist that did not before, and both change
what a busy server sees.

- **A Bluetooth proximity share reaches at most five phones**, nearest first,
  set by the new `gphone_bluetooth_max_nearby` convar. It was previously
  everyone in range, however many that was, and a photo drop writes each of them
  a full copy of the photo. Raise it if your server's idea of "nearby" is a
  whole club; the ceiling is 16.
- **A photo larger than 4MB is refused** rather than stored. The column holds
  16MB and nothing checked against anything smaller, so a modified client could
  fill `gphone_media` far faster than any camera can. Nothing the phone's own
  camera produces comes close to the cap — `gphone_camera_quality` is still the
  knob for how big stored photos actually get.

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
