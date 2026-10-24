# Changelog

What changed for the people who run micaOS on a server, and what they have to do
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
changes that put `micaschema apply` in front of an owner lands without being
named here — a versioned migration in `server/migrations/`, and a column or key
added to a `defineService` declaration. The additive half compares the
declarations against a frozen list of the schema as it stood on 2026-08-29, so
anything the tables have grown since then has to be written down before the
build goes green. What it still cannot see is listed at the top of that file.

**One section is not written for an owner at all.** `For add-on authors` under
each release answers a different person's question — somebody maintaining a
`core: false` add-on outside this repo, asking whether their bundle still
compiles and whether its manifest still asks for the right things. It is kept
separate rather than folded into the prose above because the two readers act on
different things: an owner runs `micaschema apply`, an author rebuilds and
republishes. That silence is checked as well:
`server/__tests__/sdkChangelog.test.ts` fails the build when the SDK's published
contract version moves without being named there, and when a host hook is added,
removed or moved behind a different permission — or the permission vocabulary
itself grows or shrinks — without the same. What it still cannot see is listed
at the top of that file.

Entries are hand-written. See MICA-72 for why a generated one was rejected.

## Unreleased

### Action required

**Run `micaschema apply`: every edit keeps the version it replaced (MICA-430).**
Run it straight after updating: until it has created the new table, every edit
listed here is refused with a message saying so. Editing a message, a Blab, a
Glimpse caption, a note, a contact, a place, an account's name, bio or avatar, a
Spark profile or a thread's name now copies the old text into a new table first,
in the same transaction, so a version exists exactly when the edit applied.
Sealed values are copied sealed, and `micacrypt status` and `backfill` now count
and re-seal them too; keep a key line until `status` says it can be retired.
Only staff can read versions, through the report review, and each read is
audited. Players still see only the latest text, a player's export leaves
versions out, and a privacy delete erases a player's versions like their other
rows. State is not versioned: battery, settings, scores, balances, and read and
archive flags.

`micaschema apply` creates the table `mica_versions` (`id`, `citizenid`,
`source_table`, `source_id`, `edited_by`, `reason`, `snapshot`, `op_key`,
`status`, `created_at`, `updated_at`; keys `status`, `citizenid_status`,
`source_row`, `op_key`). Migration `0017_audit_records_a_change` appends
`changed` to `mica_audit_logs`' `action`, which records a lockscreen passcode
being set, changed or removed, or a Dark Chat code rotation, without keeping the
old value.

**Run `micaschema apply`: follows, blocks, reactions and Spark history are kept
too (MICA-429).** The last tables that still deleted rows now change their
status instead. Unfollowing, unblocking, removing a reaction, un-earing a Blab,
a Spark unmatch, an expired pass, a replaced photo and Hodlr's hourly price
prune all keep the row. When a character or account is erased, its follows,
blocks, reactions, ears, swipes and matches are erased with it, so follower
counts and reaction totals stop counting it.

Migration `0016_child_rows_are_kept` adds a `status` column to
`mica_account_follows`, `mica_account_blocks`, `mica_account_reactions`,
`mica_blabber_ears`, `mica_messages_reactions`, `mica_spark_photos`,
`mica_spark_swipes`, `mica_spark_matches` and `mica_hodlr_price_history`. It
moves each unique key onto a live-only copy, so a kept row frees its slot:

- `mica_account_follows`: `live_followee`, key `follower_followee` →
  `follower_live_followee`.
- `mica_account_blocks`: `live_blocked`, key `blocker_blocked` →
  `blocker_live_blocked`.
- `mica_account_reactions`: `live_target`, key `account_target_emoji` →
  `account_live_target_emoji`.
- `mica_blabber_ears`: `live_account`, key `blab_account` → `blab_live_account`.
- `mica_messages_reactions`: `live_message`, key `message_citizen_emoji` →
  `live_message_citizen_emoji`.
- `mica_spark_swipes`: `live_target`, key `swiper_target` →
  `swiper_live_target`, and `kind_created_at` → `status_kind_created_at`.
- `mica_spark_matches`: `live_b`, key `pair` → `live_pair`.
- `mica_hodlr_price_history`: `recorded_at` → `status_recorded_at`.

Hodlr's price history now grows by about a million rows a year.

**Run `micaschema apply`: nothing deletes a row any more (MICA-428).** Every
place that used to remove a row now hides it and keeps it stored as evidence:

- **Retention** (`mica_message_retention`, `mica_dm_retention`,
  `mica_media_retention`, `mica_notification_retention`, the Dark Chat sweep)
  moves an old row to a new `expired` status.
- **A character's deletion, the orphan sweep, a player's privacy delete and
  `micaseed clear`** move rows to a new `erased` status, hidden from everyone,
  the owner included.
- **A moderator's takedown is never moved.** A deleted character's phone number
  stays live too, so it is never issued again, while their phone, passcode and
  battery are erased with the rest (MICA-440): a new ESX character in that slot
  gets a phone of its own. A player's privacy delete keeps every row of their
  phone live. A shared thread or Dark Chat channel stays live while another
  member is still in it.
- **`micamedia prune`** expires and erases; it deletes nothing.

So the database only grows. Retention frees no disk, and nothing shrinks the
tables; plan storage with that in mind.

Migration `0015_hidden_rows_are_kept` appends `expired` and `erased` to the
`status` columns in place, without rewriting a row. It also rebuilds the keys
that allow one live row per player, so that a hidden row no longer holds the
slot:

- `mica_blabber`'s `account_mouth_key` and `mica_spark`'s `live_citizen` now
  free their slot on `deleted`, `expired` or `erased`.
- `mica_hodlr` gains a `live_citizen` column and key in place of
  `citizenid_unique`.
- `mica_highscores` gains `live_citizen` and `live_citizen_app` in place of
  `citizenid_app`.
- `mica_settings` gains `live_device` and `live_device_app_key` in place of
  `device_app_key`.
- `mica_blocklist` gains `live_device` and `live_device_number` in place of
  `device_number_unique`.
- `mica_messages_participants` gains `live_device` and
  `conversation_live_device` in place of `conversation_device_unique`, so a
  phone whose member erased their data can join the same group again.

**`mica_media_delete_url` is retired.** No hosted photo is deleted from its
image host any more. The convar is ignored, and a server that still sets it gets
one warning at start; remove the line.

**Run `micaschema apply`, then `micacrypt backfill --apply`, to encrypt contact
numbers, Dark Chat, mail headers, thread names, places and invoices
(MICA-432).** With a content key set, these are now sealed as well:

- a contact's number and photo;
- a Dark Chat channel's name and join code, and each member's alias and handle,
  including who stands behind an alias;
- a mail's subject, sender and sender address;
- a group thread's name;
- a saved place's coordinates;
- an invoice's sender label and memo.

A value the server still has to look up or keep unique gets a blind index next
to it. That covers a contact's number, a join code, and an alias or handle. The
index is a keyed hash, scoped to the phone or the channel, so the same number on
two phones reads differently in a dump.

Migration `0014_private_lookups_get_blind_indexes` makes the schema changes:

- **Index columns:** it adds `phone_index` to `mica_contacts`, replacing its
  `citizenid_phone` key. It adds `code_index` to `mica_darkchat`, and
  `alias_index` and `handle_index` to `mica_darkchat_members`, and moves the
  unique keys onto them.
- **Seal keys:** it adds a per-row `seal_key` to `mica_darkchat` and to
  `mica_messages_conversations`.
- **Places:** it moves `mica_places`' `x`, `y` and `z` into one `position`
  column.
- **Contact photos:** it retypes `mica_contacts.avatar` to text.
- **Widths:** it widens the newly sealed columns.

A run that stops part-way is finished by the next one.

`micacrypt backfill --apply` then seals the values and re-keys their indexes,
and `micacrypt status` counts what is left. Run the backfill again after
rotating keys. A server with no content key stores all of this unencrypted, as
before.

One edge case: while a key is being enabled or rotated, and before the backfill
finishes, two contacts with the same number could both be saved. The backfill
reports any such pair.

**Run `micaschema apply`, then `micacrypt backfill --apply`, to encrypt notes,
contacts, the call log, places, photos and notifications (MICA-431).**

With a content key set, more private data is now sealed at rest:

- note titles and bodies;
- contact names and emails;
- numbers in the call log;
- saved place names and street labels;
- photo, voice and video bytes, with their thumbnails and alt text;
- notification titles and bodies;
- a reporter's note;
- the name a script posts under in Dark Chat.

Data on a phone is bound to that phone, not to the character, so it opens on
that phone and on no other.

Migration `0013_private_content_widens_its_columns` widens the affected columns
so the encrypted form fits; nothing stored changes. Most tables are altered in
place. `mica_contacts`, `mica_phone_call_log` and `mica_darkchat_messages` are
copied, and the console says so while it runs, so do it at a quiet moment.

`micacrypt backfill --apply` then seals what is already stored, and
`micacrypt status` counts what is left.

Two limits come with it:

- A note is now capped at about 12,000 characters, and the Notes editor shows
  the limit while you type. A longer note already stored stays unencrypted, and
  the backfill reports it as too long.
- A script adding media through the `AddMedia` export must pass ASCII-only data.
  A `data:` URI with non-ASCII bytes in it, such as a UTF-8 SVG, is now refused,
  so base64-encode it.

A server with no content key stores all of this unencrypted, as before, and the
two limits apply there too.

**Run `micaschema apply` to create Glimpse's tables (MICA-253).** Glimpse is a
new photo-feed add-on, installed from the Store, and it stores posts, their
photos and comments in three new tables: `mica_glimpse`,
`mica_glimpse_attachments` and `mica_glimpse_comments`. The change is additive
and needs no migration. A new convar, `mica_glimpse_edit_window` (seconds,
default 900, read once at resource start), sets how long a caption stays
editable.

**Run `micaschema apply` to create Dark Chat's tables and add a column to
reports (MICA-254).** Dark Chat is a new add-on, installed from the Store, for
anonymous channels joined by a code. It stores channels, members and messages in
three new tables, `mica_darkchat`, `mica_darkchat_members` and
`mica_darkchat_messages`, and adds `mica_reports.reporter_label`, which records
the alias a report was filed under so Admin can show it. The change is additive
and needs no migration. A new convar, `mica_darkchat_retention` (whole hours,
default 24, read on every use), sets how long a message is kept, and it has no
off switch: a sweep deletes older messages every 15 minutes, except one under an
open report, which is kept until the report is resolved. A new export,
`PostToDarkChat(code, alias, body)`, lets a job script post into a channel.
Staff see more than players do: `docs/security.md` lists what a moderator can
and cannot see.

**Run `micaschema apply` to create Spark's tables (MICA-255).** Spark is a new
dating add-on, installed from the Store, with swipe matching. It stores
profiles, their photos, swipes and matches in four new tables: `mica_spark`,
`mica_spark_photos`, `mica_spark_swipes` and `mica_spark_matches`. Its messages
are direct messages on the shared `dms` service (MICA-390), so they live in
`mica_blabber_dms` under Spark's own accounts and follow `mica_dm_retention`.
The change is additive, needs no migration and adds no convar: a pass comes back
after 14 days, which is a constant. A Spark account is one per character and
unlisted, so it never appears in search, follows or the public account read.

**Run `micaschema apply` to create the Casino's table (MICA-82).** Casino is a
new add-on, installed from the Store, with two games: European roulette and
Crash. Stakes and payouts are the player's bank cash through the framework, so
the app hides itself on a server with no framework, as Hodlr does. Every round
is recorded in one new table, `mica_casino_rounds`; the change is additive and
needs no migration. Three new convars, each read per call: `mica_casino_bet_min`
(whole cash, default 10), `mica_casino_bet_max` (whole cash, default 5000, the
most one spin or one Crash stake may be worth) and `mica_casino_crash_edge_pct`
(percent, default 3, clamped to 0–20). Roulette's edge is the single zero and is
not a setting. The math is written down in `docs/decisions.md`; a Crash round
whose server restarts before it settles is lost, stake included, and
`docs/security.md` says what else is accepted.

**If you imported from qb-phone and set a content key, run
`micacrypt backfill --apply` and then `micaimport qb-phone --apply` once while
the qb-phone tables still exist: the import ledger stops holding message bodies
(MICA-340).** `mica_import_ledger.source_key` kept each imported qb-phone
message's key, its participants, time, sender and body, verbatim or as an
unkeyed SHA-1, outside the sealed columns. With a content key set, new entries
are now an HMAC under that key, `hmac:<kid>:<hex>`. The backfill keys the
entries that still hold the text, the re-run keys the SHA-1 ones for every
message it still finds in qb-phone's tables, and neither imports anything twice.
`micacrypt status` counts what is left. `micaimport --apply` now refuses to run,
writing nothing, while any entry is keyed under a content key the key file no
longer holds, because it could not recognise those messages and would import
them a second time; put the key back to run it. Without a content key nothing
changes. `docs/security.md` says what an old SHA-1 entry still gives away.

**Run `micaschema apply` from the server console: a Blabber mouth that was
deleted can be mouthed again (MICA-330).** The unique key that stops a player
mouthing the same Blab twice counted deleted mouths too, so mouthing, deleting
and mouthing again answered "You have already mouthed that". Migration
`0012_blabber_mouths_unique_while_live` adds `mica_blabber.mouth_key`, which
holds the mouthed Blab unless the mouth is deleted, and replaces the unique key
`mica_blabber.account_mouth` with `mica_blabber.account_mouth_key` over it. It
adds the new key before dropping the old one, so the table is never without the
rule, and running it twice changes nothing. A mouth made again is a new post at
the top of the feed, not the old one brought back. A mouth taken down by a
moderator still holds its place, so its author cannot post it again around the
moderation, and reopening the report restores it. Until you run it, Blabber
behaves as before, except that `micaimport` reports a repeat of a mouth its
author deleted as a row it could not write, and writes it on a re-run after the
apply.

**Run `micaschema apply`: reopening a moderated report no longer brings back
content its author had deleted (MICA-386).** Reopening a report used to put the
reported row back to live whatever it was before the takedown, so a post its
author had deleted, or a listing already sold, came back. The apply adds
`mica_reports.target_prior_status`, where a takedown now records the status it
replaced, and a reopen restores that status. While another report on the same
row still stands, the row stays down until that one is reopened too. Reports
moderated before this upgrade have nothing recorded, so they restore to a
per-table guess: Blabber accounts and DMs to active, since nothing can delete
them; listings to removed; and Blabs, messages and photos to deleted. A photo
restored to deleted leaves its owner's gallery for Recently Deleted but shows
again wherever it is attached to a live message, Blab or listing. The new column
is withheld from the reporter's data export, since it says what the author did.

**Logging out to character select now ends that character's call (MICA-382).**
On a multicharacter server, a player who logs out without disconnecting used to
stay in their call, on speakerphone and broadcasting music while sitting on
character select, and a push meant for the character they left, such as a 911
call, a contact share or a notification, still reached their screen. Now the
logout ends the call for both parties, filing its call-log row under the
character who was on it, ends speakerphone and the music broadcast, and stops
addressing that character's pushes to the player. micaOS listens for
`QBCore:Server:OnPlayerUnload` on qbx and qb-core and `esx:playerLogout` on ESX
Legacy; a server whose multicharacter resource fires neither keeps the old
behaviour, where these end when the next character loads. **A `SetSignal`
override and a `LockPhone` set on the player are kept when the same character is
picked again**, so a relog does not escape a jail script's lock or dead zone;
they are cleared when a different character loads, as before.

**Run `micaschema apply` from the server console: `mica_media` records each
photo's size, so the storage quota stops reading every photo a player has
(MICA-358).** Checking the quota on a capture used to measure every stored photo
and video of that player, up to the whole 64MB default quota read from disk on
every shot, twice for a hosted one. `mica_media` gains a column, `stored_bytes`,
written with every row, and an index, `citizenid_status_stored`, which the quota
now reads instead. Migration `0011_media_records_its_size` adds the column and
fills it in for every existing photo held inline, in batches, without touching
when anything was last changed, so no deleted photo's restore window reopens.
Rows that are a link rather than a stored photo are left empty and measured as
before. Running it twice changes nothing. **Until you run it, taking, sharing or
adding a photo fails, through the `AddMedia` export too, and so does
`micamedia stats`;** the gallery still opens. The quota itself, and what counts
against it, are unchanged.

**Run `micaschema apply` from the server console: a new phone's setup now
survives a restart, and a phone holds each number in its contacts once
(MICA-335).** `mica_devices` gains `setup_pending`, set while a new phone or
tablet is still being set up (today, its default contacts being added) and
cleared when that finishes; a restart in between now finishes it on the phone's
next use instead of leaving it with some of its defaults for good. Every
existing device reads as already set up. `mica_contacts` gains `default_number`,
which marks a contact added as one of the owner's defaults, so a default the
player has since renumbered is not added again, and a generated `phone_key`
under a new unique key, `device_phone_unique`: a phone can hold a number live in
its contacts only once. Migration `0010_contact_numbers_unique_per_device` runs
first and, where a phone already holds the same number live more than once,
keeps the favourite, else the last edited, else the newest, and marks the rest
deleted (their ids are logged; nothing is erased). **Until you run it, no new
phone or tablet can be set up.** Saving a number the phone already has now says
so instead of adding a second contact, `micaimport` counts such a row as a
duplicate rather than a failure, and the `AddContact` export answers the
existing contact's id.

**Run `micaschema apply` from the server console to free the 1:1 threads one
side had left (MICA-342).** Leaving a 1:1, or a privacy delete taking a player
out of every thread, used to leave the thread holding the pair's key with
nothing able to find it again: the two players could never start a thread with
each other afterwards, and either one trying saw only "something went wrong".
Leaving and a privacy delete now release the pair as the player goes, and
migration `0009_wedged_pairs_released` releases every thread wedged that way
before this update. No thread, member or text is removed: the player still in
the old thread keeps it, readable, and the next 1:1 between the two is a new
one. Running it twice changes nothing. **`mica_messages_conversations` gains a
column, `absent_number` (MICA-350):** the number of the side that is gone, so
the player still in the thread sees that number, or their contact's name for it,
instead of "Unknown"; the migration records it for the threads it releases where
that phone still has a number, and a 1:1 started to a number nobody holds keeps
the number dialled. **Until you run it, leaving a 1:1, a player's own privacy
export and privacy delete, and starting a thread to a number nobody holds all
fail.**

**A character switch now ends what the previous character was doing on the phone
(MICA-336).** On a multicharacter server, a player who switches character
without disconnecting no longer carries the last one's call, speakerphone, music
broadcast, number sync or preferred phone slot onto the next; an active call
ends for both parties and its call-log row is filed under the character who was
on it. **Two exports change with it:** a `SetSignal` override is cleared when a
different character loads on that player, as it already was on disconnect, and a
`LockPhone` set on a player before their phone was known is cleared the same
way; a lock on a phone itself still follows the phone. A script that wants
either on the new character sets it again. qbx announcing the same character a
second time after spawn changes nothing. On qb and qbx, a money export that
answers with more than one value is now read by its first, so a payment that
went through is no longer refused.

**Run `micaschema apply` from the server console: `mica_marketplace` gains a
column, `seller_phone` (MICA-343).** A listing now shows the number of the phone
that posted it, recorded when it is posted, so on qb and standalone it keeps the
number it was posted from (on ESX a phone has no number of its own, as with
calls). The column is additive and nullable. Listings posted before it exists
have no recorded number, and show no Call or Text button rather than a number
they may never have been posted from; so does a listing posted from a phone that
had no number assigned yet. **Until you run it, posting a listing and opening
one both fail.** Sharing a contact card no longer sends the sharer's identity or
number to the players around them, and a leaderboard no longer carries each
player's citizenid.

**Run `micaschema apply` from the server console: the device table and its
column are renamed from phone to device (MICA-344).** Since MICA-264 the table
holds tablets as well as phones, so migration `0008_phones_become_devices`
renames `mica_phones` to `mica_devices`, and the `phone_id` column to
`device_id` on `mica_battery`, `mica_blocklist`, `mica_contacts`,
`mica_devices`, `mica_lockscreen`, `mica_media`, `mica_messages_participants`,
`mica_notes`, `mica_notifications`, `mica_phone_call_log`, `mica_phone_numbers`,
`mica_places` and `mica_settings`, with its keys: `device_id`,
`device_id_unique`, `device_number_unique`, `conversation_device_unique` and
`device_app_key`. Nothing is retyped and no row changes; running it twice
changes nothing. **An item carries no id at all since MICA-438**, under
`phoneId`, `deviceId` or any other key: micaOS neither reads nor writes item
metadata, and a phone or tablet is the character's own row. A script that read
`phoneId` from an item's metadata has nothing to read.

**Run `micaschema apply` from the server console, then decide whether you want
the tablet: it is now on by default, with an identity of its own (MICA-264).**
`mica_phones` gains a column, `kind`, which says whether a device is a phone or
a tablet. It is additive and every existing row reads as a phone, so no data
changes. **Run it as soon as the new version starts:** until the column exists,
a player's first phone cannot be created and a notification to a player who is
offline is dropped. A tablet now gets its own row the first time a character
needs it, and has no phone number; its notes, settings, the add-ons installed
from its own Store and its passcode are separate from the phone's, and it has a
lock screen. Admin reads the same on both devices; calls, messages, contacts,
mail, the camera, Bank and Hodlr stay on the phone. **If you do not want the
tablet, add `set mica_tablet "false"`.** `LockPhone`, `UnlockPhone` and
`IsPhoneLocked` with a `device` of `'tablet'` now act on the tablet's own lock
screen instead of failing with `unsupported`.

**Run `micaschema apply` from the server console: `mica_messages_conversations`
gains an index, `participant_b_status` (MICA-307).** It is additive and changes
no data. It serves the job-line inbox below, which still works without it, but
reads every active thread on the server instead of only the line's.

**The Store now offers the project's public add-on catalog unless you turn it
off (MICA-237).** A server that sets neither `mica_addon_catalog` nor
`mica_addon_hosts` now lists `https://mica.gg/addons/sdk-<n>/catalog.json` and
allows `mica.gg` as a bundle host. Your server fetches that catalog when a phone
asks and caches it for ten minutes; players' phones never fetch it. A phone
contacts a bundle's host to download an add-on its player chose to install, and
again at each boot for add-ons already installed. The catalog lists only add-ons
micaOS does not already ship, so no built-in app is replaced, and today it is
empty. **To keep the old behaviour, add `setr mica_addon_catalog off`** —
`setr`, not `set`, because the phones read it too; an explicitly empty value
does the same. A server with its own catalog configured is unaffected.

**Run `micaschema apply` from the server console, then decide whether to turn on
encryption at rest (MICA-165).** Migration
`0007_sealed_bodies_widen_their_columns` widens `mica_blabber_dms.body` and
`mica_reports.target_preview` in place, so their encrypted form fits; nothing
stored changes. Encryption itself is off until you set it up: run
`micacrypt keygen` from the console and follow the steps it prints — a small
`mica-keys` resource holding the key file (or a symlink to it), a
`set mica_content_key_file "..."` line in `server.cfg`, a restart, then
`micacrypt backfill --apply` to seal the messages, DMs and mail already stored.
**The key file has to sit inside a resource folder** (MICA-303): FXServer lets a
resource read nothing outside one, so a key kept anywhere else was never loaded
and encryption stayed off. If you set one up outside a resource folder, move it
(or symlink it) into `mica-keys` and restart; the console says when the key
cannot be read. **Back the key file up, and keep it out of your database backups
and out of git**: a dump and its key together protect nothing, and a lost key is
every sealed message gone. Once anything has been sealed, starting without the
key refuses new messages instead of storing them in plaintext. Until you set a
key, every start logs that bodies are stored in plaintext. **A text message is
now at most 12,276 characters** (was 65,535), and a mail body the same, so the
sealed form still fits its column; a longer `SendSystemEmail` is refused. A
persisted Blabber DM notification no longer keeps the first 120 characters of
the message; the live toast still shows them.

**On qb, run `micaschema apply` from the server console: migration
`0006_players_foreign_keys_dropped` removes every foreign key from micaOS's
tables onto `players` (MICA-300).** Until it has run, your framework deleting a
character deletes that character's micaOS rows inside the database, reported
evidence and hosted photos included, and other players' replies with them.
Afterwards nothing in the database deletes micaOS rows by itself: the
`mica:server:shell:characterDeleted` event and the orphan sweep at every start
do, keeping anything under an open report and what hangs off it, anything
another player's rows still use, and the deleted character's unresolved reports
and audit-log entries. A `players` table on a different collation no longer
blocks installing or `micaschema apply`. `apply` removes those keys even on a
database where re-importing `mica.sql` has already marked 0006 done, and the
console logs an error at every start while any remain. `apply` also adds a
`citizenid` index to `mica_messages_reactions`, which the dropped key used to
provide. `mica.sql` now refuses to import where there is no `players` table, so
it cannot be mistaken for `mica.esx.sql`. `mica:server:media:characterDeleted`
no longer removes photos attached to a message, post or listing; the full purge
does. **If your deletion flow does not fire
`mica:server:shell:characterDeleted`, a deleted character's rows, their phone
number included, now stay until the next resource start** rather than going with
the character at once; fire the event to have them go immediately. On ESX and
standalone there is nothing to apply.

**Old messages, direct messages and photos are now deleted after a window --
read this before updating, and run `micaschema apply` (MICA-167).** Three
convars set how long content is kept: `mica_message_retention` (default 180
days), `mica_dm_retention` (90) and `mica_media_retention` (365; it used to be
off by default). Set any of them to `0` or `off` to keep that content forever.
Deletion is permanent, and a photo's data goes with its row. **Nothing is
deleted on the first start after updating**: the console says, per table, how
many rows would go and at what time, 24 hours later, so you have a day to set a
convar to `0`. Never deleted: content under an open report -- the whole
conversation of a reported message, the whole thread of a reported DM, every DM
of a reported account -- until the report is resolved, and any photo still
attached to a message, blab or listing. `micaschema apply` adds a `created_at`
key to `mica_messages`, `mica_blabber_dms` and `mica_media`; until you run it
those tables are not pruned at all, and the console says so.

**A contact can ring with one of your own sounds; run `micaschema apply`
(migration `0005_contact_ringtone_holds_owner_sounds`, MICA-256).** It changes
`mica_contacts.ringtone` from a list of the five built-in tones to a
`varchar(54)`, keeping every existing value, and a second run changes nothing.

**On ESX or standalone, run `micaschema apply` after updating: migration
`0004_citizenid_widens_on_esx` widens every citizenid column to 60 characters
(MICA-289).** es_extended's multicharacter identifiers (`char1:license:<hash>`)
are 54 characters, and micaOS refused anything over 50, so those players had no
phone at all. The migration changes 32 columns from `varchar(50)` to
`varchar(60)`, keeping each one's nullability and collation, and a second run
changes nothing. **On qb it does nothing**: qb's own `players.citizenid` is 50
characters, so no qb identifier can be longer, and the migration leaves a qb
database alone even if its foreign keys are gone. It decides from the detected
framework, so it refuses to run until micaOS has started. A fresh install
imports the regenerated `mica.esx.sql`, which already has the wider columns.

**The resource is renamed from `gPhone` to `mica`, and everything keyed on the
old name moves with it (MICA-269, MICA-274).** Rename the resource folder to
`mica`, change your `ensure` line to match, and rename any `gphone_*` convar,
any `gphone.admin` ace, and any `exports['gphone']` call in your own scripts to
the `mica` spelling. A convar you miss does not error — it silently falls back
to its default, and an ace you miss silently stops granting the admin tools, so
this is worth a read of your `server.cfg` rather than a glance.

**The five console commands are renamed too**: `gphoneschema`, `gphonemedia`,
`gphonecharge`, `gphonecall` and `gphoneseed` are now `micaschema`, `micamedia`,
`micacharge`, `micacall` and `micaseed`. The old spellings are not registered,
so they fail as unknown commands rather than doing nothing quietly.

**Your database does not move with it. Import `mica.sql` (or `mica.esx.sql`)
fresh.** The schema ships as a single baseline with no migration chain behind
it: the versioned migrations that carried a `gphone_*` or `gos_*` database onto
the `mica_*` prefix have been removed along with the rest of the chain, because
micaOS had no installs outside this repo to carry. There is no upgrade path from
a pre-rename database, and there is deliberately no code left that pretends
otherwise.

If you are somehow running a `gphone_*` or `gos_*` schema, rename the tables to
`mica_*` by hand before starting the resource. Starting it first is the failure
worth avoiding: the additive half of `micaschema apply` creates the new tables
empty beside your old ones and every player looks like a fresh install, with
their real rows still sitting in tables nothing reads.

The phone itself is still called gPhone, and so is the device in a player's
hand. What changed is the name of the software it runs: a gPhone and a gTablet
both run micaOS. This release is **Seraphim**, the first of the nine choirs the
codenames now follow.

**`mica_import_ledger` is a new table — run `micaschema apply` from your server
console after updating, or import the regenerated `mica.sql` / `mica.esx.sql` on
a fresh install (MICA-233).** It carries `id`, `citizenid`, `source`,
`source_table`, `source_key`, `target_table`, `target_id`, `status`,
`created_at` and `updated_at`, with a `status` key, a `citizenid_status` key and
a `source_row_unique` key. It is the importer's record of which rows it has
already brought across, and nothing else reads it; see `micaimport` under Added.

**`mica_invoices` is a new table — run `micaschema apply` from your server
console after updating, or import the regenerated `mica.sql` / `mica.esx.sql` on
a fresh install (MICA-240).** It carries `id`, `citizenid`, `from_label`,
`amount`, `memo`, `society`, `payee`, `resource`, `expires_at`, `paid_at`,
`status`, `created_at` and `updated_at`, with a `status` key, a
`citizenid_status` key, a `citizenid_status_expires` key and a `status_expires`
key. It is how a resource bills a player through the phone: a new
`SendInvoice(citizenid, invoice)` export — `from`, `amount`, `memo`, one of
`society` or `payee`, and optional `onPaid` and `onDeclined` — writes an open
invoice and puts a notification in the player's shade whether or not they are
online, and the Bank app grew an Invoices tab where they pay or decline it.
Paying moves the money through the same payment code a transfer uses — to a
job's society account through the banking bridge, or to a character's bank —
with its refund path, and an invoice is claimed before the money moves so it can
never be paid twice. A character payee has to be online to be paid, exactly as a
transfer's recipient does; the invoice stays open until they are. Open invoices
lapse after `mica_invoice_expiry_days` (default 7) and are swept hourly. **The
`onPaid` and `onDeclined` callbacks live in memory** and do not survive either
resource restarting; a script that needs to know about a payment made after its
own restart reads the invoice row, which says `paid` and when.

**The battery charge, the external lock and the last of the phone's state follow
the phone too — run `micaschema apply` from your server console after updating
(MICA-283).** `mica_battery` gains a `phone_id` column and key, and the
migration `0003_battery_follows_the_phone` puts every existing charge on its
owner's phone, minting a phone for any character who had a charge and nothing
else, and replaces `citizenid_unique` with `phone_id_unique`: the charge is the
phone's, and a battery bank charges your phone. `LockPhone`, `UnlockPhone` and
`IsPhoneLocked` are keyed on the character's phone rather than on the player, so
unlocking one device unlocks nothing else; a lock applied before a player has
resolved a phone stays on the player, as before. `GetBatteryLevel` answers for
the phone the character is on. Nothing here changes on a server without the
phone-item gate, where every character has exactly one phone, as they do with
it.

**A phone's data now belongs to the phone: contacts, notes, media, the lock
screen, settings, notifications, the call log, saved places, the block list and
a thread's membership all follow the item — run `micaschema apply` from your
server console after updating, before players connect (MICA-282).** This is the
change the whole phone-as-item work was for: a phone's contacts, messages and
photos are the phone's, not its holder's. Since MICA-438 the phone is the
character's one phone and the item is only a key to it, so taking the item hands
its contents to nobody. It reaches every server, gated or not, because it
changes the shape of ten tables, and it is the one migration in this series an
owner cannot skip.

`mica_contacts`, `mica_notes`, `mica_media`, `mica_lockscreen`, `mica_settings`,
`mica_notifications`, `mica_phone_call_log`, `mica_places`, `mica_blocklist` and
`mica_messages_participants` each gain a `phone_id` column and a `phone_id` key.
`mica_phones` gains a `claimed` column, which nothing has read since MICA-438.
The migration `0002_phone_data_follows_the_phone` then puts every existing row
on its owner's phone — a character who already has a phone keeps it, and one who
does not gets one minted for them — attaches each character's number to it,
rewrites a 1:1 thread's `participant_a` and `participant_b` from the two
characters to their two phones, and replaces four per-character unique keys with
per-phone ones: `mica_lockscreen` loses `citizenid_unique` for
`phone_id_unique`, `mica_settings` loses `citizenid_app_key` for
`phone_app_key`, `mica_blocklist` loses `citizenid_number_unique` for
`phone_number_unique`, and `mica_messages_participants` loses
`conversation_participant_unique` for `conversation_phone_unique`. No row is
deleted and nothing is rewritten but those columns and keys. `citizenid` stays
on every table: it names the phone's owner, and since MICA-436 nothing moves it.

**What a player sees.** On a server that gates the phone on an item, a player
holding no phone item is told so rather than shown somebody else's data. A thief
using a stolen item opens their own phone (MICA-438), so the owner's threads and
passcode wait for the owner. On a server without the gate — every ESX server,
standalone, and any qb server that never set `mica_phone_item` — nothing
changes: each character has exactly one phone, as before.

**What stays with the person, deliberately:** bank, Hodlr, Marketplace listings,
Blabber and its accounts, high scores, reports, the audit log, mail, and the
messages a player wrote — the author of a message keeps its authorship, it is
the _thread_ that follows the phone. The full split and its reasoning is in
`docs/schema-and-services.md`.

**A phone number now belongs to the phone, not the character, and micaOS owns
the numbers on qb as well as standalone — run `micaschema apply` from your
server console after updating (MICA-284).** This is the one change in the
phone-as-item work that changes who a number belongs to, even though no
individual number changes value. `mica_phone_numbers` gains a nullable
`phone_id` column with a unique `phone_id_unique` key, and the migration
`0001_phone_numbers_follow_the_phone` drops `citizenid_unique`, because a number
belongs to a phone rather than to a character.

**Nobody's number changes on upgrade.** On qb and qbx the migration copies every
existing character's `charinfo.phone` into `mica_phone_numbers` as that
character's number, and the first time their number is synced, it is attached to
their phone. A character created after the update keeps the number qb issued
too: micaOS adopts it the first time they connect rather than generating one.
The one exception is two characters sharing a `charinfo.phone`, which qb does
not prevent — the second to connect is issued a fresh number, and the migration
prints how many characters that affects. Apply the migration before players
connect; a server that skips it has micaOS issue and write back fresh numbers as
players load, which is the behaviour the migration exists to avoid.

**The framework is kept in step.** Whenever the phone's number differs from the
framework's, it is written into `charinfo.phone` through the framework's own
export — qbx_core's `SetCharInfo`, or a qb-core player's `SetPlayerData` — so
`GetPlayerByPhone`, your dispatch and job scripts, and anything else reading
`charinfo.phone` keep working unmodified. A player left holding no phone keeps
the last value the framework had rather than a blank, which would break those
scripts; a phone's number stays with the phone, and the phone stays its owner's
even once its item is stolen (MICA-438), and micaOS's own lookups resolve
through the phone rather than through the stale field.

**On es_extended nothing changes.** There is no standard way to set an ESX
character's phone number, so micaOS keeps reading whatever your phone-number
resource provides, issues none of its own, and says so once at start. A
character there keeps their own number whatever item they hold. Standalone is
unchanged apart from the new column: it was already micaOS's number.

A character has one phone and so one number, with the phone-as-item gate
(`mica_phone_item`) or without it (MICA-438): every server, qb included, behaves
as one number per character, exactly as before, with the number now recorded in
`mica_phone_numbers` as well as `charinfo`. Turning the gate on or off changes
nobody's number (MICA-439, below).

**`mica_messages` gains a `conversation_id_id` key on `(conversation_id, id)` —
run `micaschema apply` from your server console after updating, or import the
regenerated `mica.sql` / `mica.esx.sql` on a fresh install (MICA-218).** A
thread is read one page at a time, newest first, and until now every page was a
lookup on the conversation followed by a sort of everything in it. With the key
it is a single backward index walk that stops at the page size. No data is
rewritten and nothing else about the table changes; a server that skips the step
keeps working and keeps paying the sort.

**`mica_messages` gains a `reply_to_id` column and a `reply_to_id` key — run
`micaschema apply` from your server console after updating, or import the
regenerated `mica.sql` / `mica.esx.sql` on a fresh install (MICA-209).** Until
now a reply's quote was carried only in the live push, so it looked right to
whoever was online when it arrived and vanished on the next open. It is stored
on the row now. Existing replies have no target on record and render as plain
messages; nothing else about the table changes and no data is rewritten.

**The resource now declares `node_version '22'` in `fxmanifest.lua`, so its
server half runs on FXServer's Node 22 runtime rather than the default Node 16 —
check that your artifact is recent enough to carry Node 22 before updating.**
The directive is part of the resource manifest reference and any current
recommended artifact honours it. An artifact old enough not to know it ignores
the line, starts the server scripts on Node 16 anyway, and the bundle, which now
targets ES2023, fails on its first use of a newer builtin rather than at startup
— so an old artifact shows up as a mid-session error, not a refusal to start.
Nothing else changes for an owner: no schema, no convar, no command. The client
half is untouched; it runs in the game client's own V8, not in Node.

**`mica_phone_numbers` is a new table — run `micaschema apply` from your server
console after updating, or import the regenerated `mica.sql` / `mica.esx.sql` on
a fresh install.** It carries `id`, `citizenid`, `number`, `phone_id`, `status`,
`created_at` and `updated_at`, with a `status` key, a `citizenid_status` key,
and two unique keys, `number_unique` and `phone_id_unique`. It began as the way
micaOS issues a phone number on a server running with no framework, where there
is no framework to issue one — a number generated at random on a player's first
connection that stays with them across reconnects — and MICA-284 above made it
the record of every number on qb too. **On ESX the table is created and stays
empty**, and the framework's own number is used exactly as before. It is created
on every framework rather than only where it is used because `mica.sql` and
`mica.esx.sql` differ only in their foreign keys onto `players`, and a third
artifact would be a third thing to import the wrong one of.

**`mica_contacts` gained a `ringtone` column — run `micaschema apply` from your
server console after updating, or import the regenerated `mica.sql` /
`mica.esx.sql` on a fresh install.** Contacts can now carry a per-contact
ringtone override, one of the client's existing ringtone choices. It is nullable
with no default, and null means "use the system ringtone" — an existing contact
is never backfilled to a specific tone.

**`mica_audit_logs.action` gained a `viewed` value, via a new migration
(`0002_audit_logs_add_viewed_action`) — run `micaschema apply` from your server
console after updating, or import the regenerated `mica.sql` / `mica.esx.sql` on
a fresh install.** An admin opening the report queue or history now writes an
audit entry for each reported item they actually see, not only for a moderation
decision — the ledger previously recorded a takedown but not the read that
preceded it. No existing row changes shape or meaning.

**`mica_messages_conversations` gained `participant_a`, `participant_b` and a
generated `pair_key` column, plus a migration (`0003_conversations_pair_key`) —
run `micaschema apply` from your server console after updating, or import the
regenerated `mica.sql` / `mica.esx.sql` on a fresh install.** A 1:1 thread's two
participants are now snapshotted onto the conversation row itself and normalised
into `pair_key`, which a unique index (`pair_key_unique`) constrains — closing
the race where two people opening a chat at the same moment could end up with
two threads for the same pair. The migration backfills the new columns for
existing one-to-one threads and adds the index; if your server already has more
than one active thread for the same pair (a residue of that race before this
fix), the index is added as a plain, non-unique key instead — nothing is merged
or deleted, and no message history is touched.

**`mica_lockscreen` is a new table — run `micaschema apply` from your server
console after updating, or import the regenerated `mica.sql` / `mica.esx.sql` on
a fresh install.** The lock screen's passcode (display state, not a security
boundary) is now stored server-side as a salted hash, one row per citizenid, and
is never sent back to the client in any form. Its columns are `passcode_hash`,
`passcode_salt`, plus the usual `status` and `updated_at` every micaOS table
carries. Three new exports, `LockPhone`/`UnlockPhone`/`IsPhoneLocked`, let
another resource force the lock screen up or down independently of the passcode.

**`mica_places` is a new table — run `micaschema apply` from your server console
after updating, or import the regenerated `mica.sql` / `mica.esx.sql` on a fresh
install.** The Places app can now save a named location at the player's current
position. Columns are `id`, `citizenid`, `name`, `street_label`, `x`, `y`, `z`,
`status`, `created_at` and `updated_at`, indexed by `status` and
`citizenid_status` like every other owner-scoped table; `x`/`y`/`z` are resolved
server-side and are never client-writable.

**Hodlr now trades on a spread instead of a single flat price — a real change to
your economy, controlled by a new convar, `mica_hodlr_spread_pct` (default `2`,
meaning 2%).** A buy settles slightly above the mid/reference price the chart
plots and a sell settles slightly below it, each rounded against the trader
rather than to nearest, so round-tripping a buy into an immediate sell is a
guaranteed small loss rather than free. `portfolio`'s valuation is unaffected —
it still uses the flat mid price. Set `mica_hodlr_spread_pct 0` to keep the old
single-price behavior exactly. This ships with no cooldown and no per-trade
position limit beyond the existing `mica_hodlr_trade_max` — the spread itself is
what discourages rapid trading, by construction.

**`mica_blocklist` is a new table — run `micaschema apply` from your server
console after updating, or import the regenerated `mica.sql` / `mica.esx.sql` on
a fresh install.** A player can now block a phone number; a blocked call fails
with the same "Number unavailable" message and call-log entry as a genuinely
unreachable one, and a blocked sender's messages are still written but no longer
pushed live. Columns are `id`, `citizenid`, `number`, `status`, `created_at` and
`updated_at`, indexed by `status`, `citizenid_status` and a unique
`citizenid_number_unique`. A new convar, `mica_emergency_number` (default
`911`), always connects regardless of any block — a player registered under that
phone number (a dispatch resource's own setup, not a new micaOS feature) is
reachable no matter who dials it. `GetEmergencyNumber` is a new export for that
resource to read the configured number rather than duplicate the convar name.

**`mica_messages_reactions` is a new table — run `micaschema apply` from your
server console after updating, or import the regenerated `mica.sql` /
`mica.esx.sql` on a fresh install.** Native Messages (SMS-style threads) can now
be reacted to with an emoji, the same shared primitive Blabber's DMs already
used, but stored separately rather than in Blabber's own
`mica_account_reactions`: that table's reactor is an `account_id`, which
Messages has no equivalent of, so this one keys a reaction on `message_id`,
`citizenid`, `emoji` and `created_at` instead, alongside the usual `id`. No
existing table changed shape.

**If you run a third-party add-on that reads or changes the phone's theme,
wallpaper, display size, home grid, clock format, keyboard shortcuts, hardware
(battery/signal/bluetooth/volume), notification settings, or app registry, check
it against this release.** Eight SDK hooks that used to bundle a low-stakes read
with a global write behind one permission now split into a read half and a
`-write` half, the same way `useAccount`/`useBank` already did:

- `useTheme` / `useThemeWrite` — permission `theme-write`
- `useWallpaper` / `useWallpaperWrite` — permission `wallpaper-write`
- `useDisplay` / `useDisplayWrite` — permission `display-write`
- `useClock` / `useClockWrite` — permission `clock-write`
- `useKeybinds` / `useKeybindsWrite` — permission `keybinds-write`
- `useSystemHardware` / `useSystemHardwareWrite` — permission
  `system-hardware-write`
- `useAppRegistry` / `useAppRegistryWrite` — permission `app-registry-write`
- `useNotificationSettings` / `useNotificationSettingsWrite` — permission
  `notification-settings-write`

Every setter that used to come back from the read hook — `setThemeSeed`,
`setWallpaperSeed`, `setDisplaySize`, `setHomeGridSize`, `setBinding`,
`toggleBluetooth`, `unregisterApp`, `setAppNotificationPolicy`, and the rest —
moved to the matching write hook, gated by the matching new permission.
Declaring `theme` alone used to also mean "may repaint the whole phone for every
app"; now it means only "may read the active theme," and an add-on that wants to
change it has to say so (MICA-127). `app-registry-write` and
`notification-settings-write` were already unreachable for a sandboxed add-on
regardless of permission (installing an app or muting a rival was never
something an add-on's manifest alone could unlock), so those two are a
disclosure fix rather than a new restriction. Nothing that ships with the phone
is affected — Settings (and, for `app-registry-write`, the Store) are the only
in-tree apps that ever held any write half, and their manifests already declare
the new permissions.

**If you run a third-party add-on that draws reactions, check it against this
release.** `ReactionBar`, the SDK component an add-on draws a reaction row with,
changed shape: it now takes `summary` and `ontoggle` in place of `counts`,
`mine`, `onreact` and `onunreact`. An add-on written against the old props will
not render its reactions until its author updates it. Nothing that ships with
the phone is affected (MICA-98).

**If you have recently upgraded qb-core or qbx_core, watch your server console
for `[FrameworkBridge]` errors after this update.** micaOS now refuses a money
move its framework did not confirm with a plain `true`, and refuses to spend
against a balance that did not come back as a number — see the first entry under
Fixed. On a framework whose money calls answer the way they always have, nothing
changes. On one whose contract has moved, players will find a payment refused
where it previously appeared to succeed, and the console will name the call that
answered oddly. That is the safer of the two failures, but it is visible, and
the log line is what tells you which resource to look at.

**If you run ESX, a player has one phone — not one per character.** micaOS keys
every row it owns on one identity column, `citizenid`, and on ESX that column
holds the player's own identifier — the license or steam string the framework
knows them by. On qbx_core and qb-core it holds the character's id, so each
character carries its own contacts, messages and gallery. The asymmetry is
deliberate rather than a gap: ESX has no character system to hang a separate
phone on, and giving micaOS a second notion of identity would have put the
question into every ownership check in the resource instead of one place
(MICA-150).

**Moving an existing server between ESX and a qb core re-keys every phone, and
micaOS ships no migration for it.** The rows written under the old identity stay
in the tables, but nobody resolves to them any more, so players arrive to empty
phones rather than to merged ones — and if changing framework means dropping and
recreating the framework's own `players` table, the foreign keys described in
the README take every one of those rows with it. Neither direction is a
conversion. Plan a framework switch as a data migration you write, or as a
deliberate reset your players are told about.

**Run `micaschema apply` from your server console after updating.** This release
carries the first versioned migration micaOS has ever shipped,
`0001_repair_conversation_participants`, and it repairs rows that a bug let
anyone write. Until you run it, the repair has not happened on your database.

Two things were wrong in Messages, and both left marks that a code fix alone
cannot clear. `is_group` was set by whatever the phone sent rather than by who
was actually in the thread, and the Messages app hides the member list, the
group heading and every sender name while that flag is off — so a modified
client could put a third account into a conversation its two participants were
shown as a private one-to-one, and they had no screen anywhere in the app on
which to find it. Separately, the list of people to add was taken as sent, with
no limit and no check for repeats, so one number listed five hundred times
became five hundred live rows for one player and five hundred copies of every
later message delivered to them, for as long as the thread existed.

**This migration deletes rows, and it is the only part of micaOS outside
`micamedia prune` that does.** It removes the surplus participant rows — the
ones naming a person a second, or five-hundredth, time in a thread they were
already in — keeping one row for each person in each conversation. Those rows
are artefacts of the bug and nobody asked for them, but you are entitled to know
they go, and to take a backup first if you would rather. **No conversation and
no message is touched, and nobody is removed from a thread they are actually
in**: where a person has both a current row and older ones, the current row is
the one kept.

They have to be deleted rather than merely marked as departed, because the
constraint described below counts rows and not live ones — five hundred rows
flagged "left" collide with it just as surely as five hundred active ones.

The migration then recomputes `is_group` for every conversation from the number
of people actually left in it. That step is what makes an already-tampered
thread visible: the member list and the sender names come back, and anyone who
should not have been in the conversation is finally on screen. **So it is worth
reading your players' reports of odd threads after this rather than before** — a
group that had been presenting itself as a private chat starts showing its
members.

Last, it puts the rule into the table itself so nothing can write those rows
again. On `mica_messages_participants`, the index `conversation_participant` is
replaced by a unique `conversation_participant_unique` over the same two
columns, which is what makes one row per person per thread a guarantee rather
than a convention. The rename is not cosmetic: micaOS compares the indexes on
your database against the ones it expects **by name only**, so had the existing
name been reused your server would have kept a non-unique index forever and
reported nothing wrong. The migration therefore adds and drops the index itself
rather than trusting that comparison, and both steps check whether they are
needed first — so an apply that is interrupted can simply be run again. The new
key goes on before the old one comes off, so if anything does go wrong your
table is left exactly as it was rather than with no index at all.

**`mica_phones` is a new table — run `micaschema apply` from your server console
after updating, or import the regenerated `mica.sql` / `mica.esx.sql` on a fresh
install (MICA-280).** It carries `id`, `citizenid`, `phone_id`, `status`,
`created_at` and `updated_at`, with a `status` key, a `citizenid_status` key and
a unique `phone_id_unique` key. It gives the phone an identity of its own: a
row, with an id that the phone's data is keyed on. The phone number is the first
thing to follow it (MICA-284, above); contacts, messages and the rest of a
phone's data come in a later release.

`phone_id` is unique; `citizenid` deliberately is not, because a database an
earlier development build ran on can hold several rows for one character. The
row is found by its character and is not carried in an item (MICA-438, below),
so this needs no particular inventory: ox_inventory, qb-inventory and
es_extended's own inventory behave alike.

Every convar below defaults to the behaviour a server already had, so an update
that sets none of them changes nothing for your players.

**`SendMessage(citizenid, message)` puts a text in a player's Messages from a
sender that is not a player, and needs `micaschema apply` (MICA-223).**
`mica_messages` gains an `external_sender` column: the label a resource gave for
the sender -- a business name, or the number of a line it holds. On such a row
`citizenid` is the recipient, because the row is theirs to keep and to lose with
their character, and the column is what tells the phone the text arrived rather
than left. Run `micaschema apply` after updating; until you do, the export fails
with `internal_error` and the rest of Messages is unaffected.

**On ESX, micaOS now needs ESX Legacy (MICA-421).** It reaches ESX only through
the `getSharedObject` export that ESX Legacy's `es_extended` provides. The
fallback to the `esx:getSharedObject` event, for ESX builds from before Legacy
(about 2021), is gone on the server and the client. On such a build the phone
finds no framework, and the server console and the player's F8 console each log
one error naming the cause; update `es_extended` to Legacy. qb-core, qbx_core
and standalone servers are unaffected.

**A battery saved only under the old `phone_battery` metadata key starts full
(MICA-421).** When a phone has no row in micaOS's battery table yet, its charge
is taken from the character's `mica_battery` metadata, and no longer from the
older `phone_battery` key, which nothing in micaOS writes. A phone whose only
saved charge was `phone_battery` loads at 100% once and is saved normally from
then on.

### Added

**A character has one phone, and a phone item is a key to it (MICA-438).**
Holding any phone item opens your phone, with everything on it and your number.
There are no burners to buy and no phone to remember to pick: one keybind, one
phone. A character has exactly one phone and one tablet, each a row in
`mica_devices` found by the character, and the item carries nothing; micaOS
neither reads nor writes an inventory item's metadata. This replaces the model
of MICA-219 to MICA-436, where each item carried a phone of its own, and it
supersedes the used-phone-is-a-brick rule of MICA-436 below.

**What a player sees.** A player whose phone is stolen buys a new phone item and
has everything back — contacts, messages, photos, settings, the passcode and the
number — as though restored from a backup, and getting the stolen item back
changes nothing. A thief using the item opens their own phone, with their own
data, and cannot reach the owner's. A phone item sold or given to someone else
is a key to that person's phone, so a phone cannot be passed on with what is on
it, and a second item is a spare key rather than a second phone.

**What you see as an owner.** Nothing to run: no schema change, no convar, no
command, so no "Action required". `mica_devices.claimed` stays in the table and
nothing reads it.

- **ESX and qb-inventory need nothing special.** The model counts the item and
  needs no per-item metadata, so the inventory no longer has to be ox_inventory
  for anything but the usable-item hook that opens the phone when the item is
  used.
- **Metadata on existing items is ignored.** A `deviceId` an earlier build wrote
  into an item stays there, unread. A script of yours that read it has nothing
  to read.
- **A character who used two phone items on a development build** now has the
  newest row as their phone (newest `updated_at`, then the highest `id`; in
  practice the last one created or claimed). The older rows stay as they are,
  unread and unmerged, and the console says so once per character at start.
  `docs/phone-as-an-item.md` has a query to find them. A server that never ran
  one has none.
- **On an ungated server, each character's legacy number row is attached to
  their phone on that phone's first number sync after this update.** The number
  does not change, no version row is written, and it works on any schema this
  code runs on, so there is nothing to run: `micaschema apply` still gates
  MICA-430's versioned edits as before, and not this. A row from before MICA-436
  that sits on a phone and names another character is detached back to that
  character as a legacy number, logged once by token, and their next sync
  attaches it to their own phone.
- **Your scripts get simpler.** A shop sells any phone item. A robbery script
  moves a key and nothing more: moving the item with or without its metadata, or
  giving a fresh one, comes to the same. An evidence script can store "1 ×
  phone" as a count and give back a fresh one. `docs/phone-as-an-item.md` has
  the scripts' side.

**Setting or clearing `mica_phone_item` changes nobody's number (MICA-439).**
Gated or not, a character's number is read from, and attached to, their one
phone, so it survives the convar being turned off and on again, on qb and qbx
alike. ESX keeps no number rows, and standalone has no item gate to toggle. See
"Turning the gate on and off" in `docs/phone-as-an-item.md`.

**What is not tested.** None of this has run in game. Nothing in the in-server
suite has a player hold or use a phone item: the qbx and esx runs only check
that the item exists and is registered as usable, and their item-metadata
scenarios went with the metadata, so each runs five scenarios. The model is
covered by unit tests, not by a running server.

**A phone no longer changes hands (MICA-436).** Until now, the next player to
use a phone that had changed inventories became its holder, and every contact,
message, photo, note and setting on it, and its number, were rewritten to them.
That rested on item metadata that any resource can write and on a lock screen
only the client enforces, so a stolen or duplicated phone was a full read of its
owner's. The handover is gone, removed rather than switched off, and nothing is
written when somebody else holds the item. What replaced it is the entry above:
the item is a key, and whoever holds it opens their own phone. A thief's
`charinfo.phone` is not rewritten to the stolen number, and texts and calls to
that number are still filed on the phone, where they wait for its owner.

`'handover'` stays a version reason in the ledger, for history, and nothing
writes it any more: a legacy number being attached to a phone is a plain update
(MICA-438).

**`micastorage` shows where the database's space goes.** Nothing is deleted any
more, so the tables only grow. The new command lists every `mica_` table,
largest first, with its data and index size and its rows by status, keeping
`active` apart from every hidden or settled status. It changes nothing, and is
admin-gated like `micamedia`.

**The tablet has a battery of its own (MICA-337).** It drains while carried and
charges on its own, separately from the phone, and shows its own flat-battery
screen; a flat tablet never stops the phone, or the reverse. A battery bank
charges the tablet if it is open, otherwise the phone. `GetBatteryLevel`,
`SetBatteryLevel`, `AddBatteryCharge` and `SetCharging` take an optional
trailing `device`, defaulting to the phone, so existing scripts are unchanged;
`'tablet'` answers `disabled` while the tablet is off or the player holds none.
No owner action.

**A fresh install no longer imports any SQL (MICA-306).** Start micaOS against
an empty database and it creates its own schema for your framework, records the
shipped migrations as applied, and says so in the console. It needs CREATE,
INDEX and REFERENCES on that first start, and your framework started before it.
It acts only on a database holding no micaOS table at all: **an existing install
is never changed automatically**, and keeps updating through `micaschema apply`.
To keep importing by hand, `set mica_auto_schema 0`. If an earlier re-import
left your migration record empty and a table is missing, the console now says so
at start, with the steps to fix it; nothing stops.

**A Store add-on can come with a server half of its own (MICA-308).** Its author
ships a small FiveM resource beside the add-on's bundle; you install it like any
other resource, `ensure`d after `mica`, and it registers with micaOS through the
new `RegisterService` export. micaOS still stands in front of every call from a
phone: the same rate limits, the payload checked against the add-on's declared
fields before the resource sees it, and the player resolved on the server. The
resource keeps its own data in its own tables; nothing enters micaOS's schema.
An add-on whose resource is not installed opens as before, and its server calls
fail. `mica_disabled_apps` switches an add-on's server half off along with its
app. Nothing changes on a server that installs no such resource.

**Job lines: a number like 911 that rings everyone on duty, with no script
(MICA-307).** Set `mica_job_lines` to a JSON array (or a path to a JSON file in
the resource) of `{ "number", "label", "jobs" }` entries, and a call to that
number rings every connected player whose active job is one of `jobs` and who is
on duty, all at once; the first to answer takes the call. Off until you set it,
so nothing changes on a server that does not. `RegisterNumber`'s `onCall` can do
the same from a script by answering `{ action = 'ring', sources = { ... } }`. A
text to a job line lands in a shared inbox in the Jobs app, where everyone on
duty for the line sees every caller's thread and replies as the line, under its
label; a thread that starts waiting for an answer notifies them once, with the
line and the sender's number, never the text. A call through a job line shows
"via" and the line's label on the ringing phone. If a dispatch script of yours
already registers the same number, whichever starts first keeps it and the
console names the other; drop one of the two.

**Message, DM and mail bodies can be encrypted at rest (MICA-165).** With
`mica_content_key_file` set, text messages, Blabber direct messages, mail bodies
and the snapshot a report keeps of what was reported are sealed with AES-256-GCM
in the server before they reach the database, and opened on every read: threads,
inbox previews, the moderation queue, a player's own export, and the exports
other resources call. Each value is bound to its table, column, owner and
thread, so one copied into another player's or another conversation's row does
not open. This defends a leaked database dump, not the server's operator, and is
not end-to-end encryption; `docs/security.md` says what stays readable. The
console-only `micacrypt` reports how much is sealed, seals what was stored
before the key (`backfill --apply`, 500 rows at a time, safe to repeat, never
marking a message edited), rotates to a new key the same way, and writes a key
file (`keygen`). A body that will not open, because its key is no longer in the
file, reads as 🔒 instead of breaking its thread. On a server with no key, a
message or DM a player types that begins with `$mc1$`, the encrypted form's own
prefix, is refused with a message saying why.

**A player can see, copy and delete everything micaOS holds for their character
(MICA-168).** Settings > Privacy > Your data lists it by category and copies it
as JSON; credentials, other players' details and the audit ledger are left out,
and photo bytes are shown as sizes. Deleting it takes typing `DELETE`, runs at
most once an hour, and never takes another player's rows: a thread with someone
else's messages in it, a post with someone else's reply, and anything under an
open report are kept, and the reply says how many. A player's own delete also
keeps the audit ledger, reports still pending review, unpaid invoices, the
import ledger and the phone itself (its number, battery and lock); deleting the
character still removes those. Both requests are audit-logged, and an export is
never posted to your staff Discord. No owner action.

**The tablet can be turned on, and gated on an item of its own (MICA-263).** Two
new convars: `mica_tablet` turns the tablet on (on by default since MICA-264,
above), and `mica_tablet_item` gates it on an inventory item independently of
`mica_phone_item`. `IsPhoneOpen`, `SetPhoneEnabled`, `LockPhone`, `UnlockPhone`,
`IsPhoneLocked` and `OpenApp` take an optional trailing `device`, defaulting to
the phone, so existing scripts are unchanged. No owner action; see the README's
[The tablet](README.md#the-tablet).

**A script's phone number can receive texts and reply to them (MICA-275).**
`RegisterNumber` takes an optional `onMessage` handler, called after a player's
text to that number is saved; the script replies with `SendMessage`, and both
directions land in the one thread the player sees. A player's reply to a
`SendMessage` text from a registered line used to be stored and reach nobody.
Leaving a thread with a line now deletes it for that player, so the line's next
text opens a fresh thread rather than one they can no longer see. **For script
authors:** `RegisterNumber` now refuses a number with letters in it, with
`invalid_args`. No owner action; the details are in the README's
[Exports for other resources](README.md#exports-for-other-resources).

**Places has a map, and friends can share their live location (MICA-244).** The
map pans and zooms and shows saved places, shared pins and your own position.
**No map image ships**: GTA's map art is Rockstar's, so set `mica_map_image` to
an https URL or a file under `branding/`, and `mica_map_bounds` if your image
does not use the common 8192px atlas; without one a neutral grid is drawn. A
player can share their location with up to 10 contacts for 15, 60 or 240
minutes. The server reads the sharer's position itself every
`mica_location_interval` seconds (default 5), so no client can report someone
else's. Recipients who blocked the sharer are skipped, and a status-bar icon
shows while a share is live. Shares live in memory, so a restart ends them.

**Speakerphone that nearby players actually hear (MICA-246).** On speaker, the
server adds players within `mica_speaker_range` meters (default 4, at most 10,
up to six players) to the call's pma-voice channel at `mica_speaker_volume`
(default 30), and the far side hears them. The sound is in their ear, not played
from the phone's position: the release client has no native for that. Set
`mica_speaker_range 0`, or run without pma-voice, and the Speaker button is
hidden rather than doing nothing. `docs/testing-voip.md` has a three-player
manual test.

**Photos can live on an external image host instead of the database
(MICA-243).** Off by default; nothing changes until you set
`mica_media_upload_url`. The server posts each JPEG there, with the header in
`mica_media_upload_header` and the form field in `mica_media_upload_field`, and
stores the link found at `mica_media_upload_response_path`. Set
`mica_media_image_host` to the host the links point at: a link on any other host
is refused. The API key never reaches a player. An upload that fails for any
reason stores the photo in the database as before, so a host outage loses
nothing, and existing photos keep working. Set `mica_media_delete_url` and a
hosted file is deleted once no photo uses it. That happens on the retention
sweep, on `mica:server:shell:characterDeleted`, and on the start-up orphan sweep
(MICA-292). Without the delete URL, the console counts the files left behind. A
photo under an open report keeps its row and its file through all of these until
the report is resolved. If you change `mica_media_image_host` later, files left
on the old host are counted in the console by host, and never deleted there.
**On qb, fire `mica:server:shell:characterDeleted` before your framework deletes
a character.** The `players` cascade removes the photo rows before micaOS can
see them, so those files would stay reachable on the host. micaOS warns about
this at every start while an image host is set. README's "Configuration" has the
details.

**A control center of its own (MICA-247).** Pull down from the right side of the
status bar, or tap Open Control Center in the notification shade: cellular,
Bluetooth, airplane mode, flashlight and do not disturb, plus brightness, volume
and what is playing. Players reorder and hide the toggles, per character. Store
add-ons can add up to three toggles of their own, shown in a section under the
add-on's name, never mixed in with the built-in ones. No owner action.

**Your own ringtones and notification sounds (MICA-256).** Put audio files in
`branding/sounds/` and restart: they appear beside the built-in tones in
Settings > Sound, which now also has a separate notification tone, and in a new
ringtone picker on each contact. A call from a contact rings with that contact's
tone. See README's "Your own images and sounds" for formats and limits; the
contact ringtone needs the migration above.

**Home-screen widgets (MICA-245).** Long-press an empty spot on the home screen
to enter edit mode, then Add widget: a clock and date, battery and signal, or
what Music is playing, each in a wide (2x1) or large (2x2) size. Widgets move,
persist and are removed like icons, and shrinking the grid to fewer columns
reflows them rather than dropping them. Store add-ons can ship a widget of their
own; it runs in the add-on's sandbox with the add-on's permissions, and one that
hangs the home screen is paused on the next start ("Widget paused") until the
player removes and re-adds it. No owner action.

**A registered line can hang up, and `blockable = false` works (MICA-278).** The
new `EndLineCall(callId)` export ends a call your line answered, with the
`callId` `onCall` received, and refuses one on another resource's line. A player
who blocks a line's number already got no notification from its texts; what
changes is `blockable = false` on `RegisterNumber`, which now actually delivers
regardless -- and only for texts the owning resource sends, so another script
cannot borrow it by putting the number in `from`. Calls to a line are never
refused by a blocklist. No schema change.

**Brand the phone: theme colour, wallpapers, boot logo and frame (MICA-236).**
Four new convars, all off by default, so an update changes nothing until you set
one. `mica_theme_seed` (`#rrggbb`) is the colour a phone's theme is generated
from until its player picks their own; their choice then wins, even if you
change the seed later. Images go in the new `branding/` folder in the resource,
which is served to the phone and which an update never overwrites — the release
ships only its README. The png, jpg and webp files in `branding/wallpapers/` (or
the folder `mica_wallpapers` names, under `branding/`) appear in Settings >
Display beside the built-in wallpapers, up to 50, read at resource start.
`mica_brand_logo` names an image under `branding/` for the new boot and
power-off screens, which show the micaOS mark without it; the boot screen plays
on the first open of a session and when a dead battery comes back, is skipped
under reduced motion, and gives way to an incoming call. Players can now choose
a notch or punch-hole frame, and a black, graphite or silver bezel, in
Settings > Display; `mica_default_frame` (`classic`, `notch` or `punch`) is the
one a player starts with. The screen stays the same size in every frame, so no
app changes. Paths outside `branding/` are refused with a warning at start. No
schema change. The convar table in README has all four.

**Add a language by dropping files in, with no rebuild (MICA-235).** The release
now carries `locales/en/` and `locales/de/` — every string the phone shows, one
JSON file per app — and the server reads the whole `locales/` folder at start.
Copy `locales/en/` to `locales/<lang>/`, translate the values and restart the
resource: the language appears in Settings > Language and `mica_locale` accepts
it. A key a file leaves out falls back to English, and the server console lists
what each language is missing. A file in `locales/en/` or `locales/de/`
overrides the built-in string for its keys. Store add-ons are translated the
same way, from `locales/<lang>/<add-on id>.json`. README's "Adding a language"
has the layout. **One change to check:** `mica_locale` now has to name a
language present in `locales/`; `en` and `de` always are, and anything else logs
a warning at start and falls back to the player's own language, as an unset
convar does.

**Bring players' data across from qb-phone, lb-phone or NPWD (MICA-233).**
`micaimport <qb-phone|lb-phone|npwd>` in the server console reads the old
phone's tables where they sit, in the same database, and reports what it would
bring across — contacts, message threads, gallery images and posts, which land
in Blabber (or are counted as skipped if Blabber is not installed or is in
`mica_disabled_apps`) — table by table, with every row it would skip counted
under a reason. It writes nothing until you add `--apply`, and a second
`--apply` brings nothing new, so an interrupted run is safe to repeat. Run it
from the console only; nobody in game can, admins included. A row whose owner
micaOS cannot match to a character is reported, not dropped silently.
Attachments, embeds, qb locations, texts to a number no player holds (a business
line), and posts over Blabber's 280 characters are not brought across, and the
report says how many. Gallery images that are links arrive as links and do not
count against the media quota; an image stored inline in the old phone counts,
and one past a player's quota is reported, not written. Take a database backup
first, and run `micaschema apply` before it, since it needs the new ledger table
above. The old phone's tables are only read, never changed.

**Bridges for scripts written against lb-phone or NPWD (MICA-232).** The release
now carries `bridges/lb-phone/` and `bridges/npwd/` inside the `mica` directory.
Each is a small optional resource that answers the original phone's export names
by forwarding to micaOS, so dispatch, MDT, garage and housing scripts that call
`exports['lb-phone']` or `exports.npwd` keep working. Nothing ensures them and
nothing changes until you act: copy the one you need into `resources/`, remove
the real phone of that name, and `ensure` it after `mica`. A name with no micaOS
equivalent logs once, saying what to use instead, and answers `nil` or `false`
rather than throwing into your script. README's "Coming from lb-phone or NPWD"
section has the full mapping, generated from the bridges' own source.

**Four server exports and two client exports.** Server: `IsInCall(source)`,
`HasPhoneItem(source)`, `GetSourceFromNumber(number)` and
`GetCitizenIdFromSource(source)`. Client: `IsInCall()` and
`IsPhoneEnabled(device?)`. Additions only; `GetApiVersion` stays at 1 on both
sides.

**Disable apps, set the dock and seed contacts from `server.cfg` (MICA-234).**
Three new convars, all off by default, so an update changes nothing until you
set one. `mica_disabled_apps` takes a comma list of app ids and hides them from
the launcher, drawer, search, dock and Store; the server also refuses the events
of an app whose service no other app uses (Blabber, Snek's high scores, Hodlr,
Jobs, Mail, Snatchr, Notes, Places, and Bank's invoices), while Messages,
Contacts, Media, Music, Bank and social accounts are hidden only, since other
apps — add-ons included — depend on them. Settings cannot be disabled. Plain
`set` is enough for all of that; use `setr` only if you also want the client
`OpenApp` export to refuse a disabled app, which then returns `app_disabled`.
`mica_default_dock` sets the phone's four dock slots for a player who has not
arranged their own. `mica_default_contacts` takes inline JSON or a path to a
JSON file inside the resource, and seeds up to 50 of those contacts into a phone
once, in the background, when the server first creates it — phones that already
exist are not seeded, a failed seed is logged rather than retried, and a contact
a player deletes stays deleted. No schema change. The convar table in README has
all three.

**Home search reaches Notes, and any app that asks (MICA-286).** MICA-248 left
Notes out, because it is a `core: false` add-on whose store lives inside its
frame and core cannot name an add-on. An app now contributes its own rows
through `useSearchProvider`, so Notes is searchable, and a note hit opens that
note. Snatchr's listings gained the per-listing deep link they were missing, so
a listing hit opens the listing rather than the app root.

**Home search reaches the gallery, mail and Snatchr listings (MICA-248).** The
drawer's search covered apps, contacts and conversations. It now composes three
more sources from their client-side caches, each in its own section with a deep
link into the item: a photo opens Media on it, a mail opens Mail on it, and a
listing opens Snatchr, which has no per-listing deep link yet. Every source
contributes only when its owning app is visible to this player and device, the
same rule the app row uses. Notes is a `core: false` add-on whose store lives
inside its frame, so it is not searched yet: the shell half of an add-on
provider registry landed with this, and the SDK hook and facet it needs are the
remaining piece. The field's label now says "Search your phone".

**The moderation ledger can mirror to a Discord webhook (MICA-242).** Set
`mica_discord_webhook` and a staff channel receives an embed for every
moderation action, every admin read of reported content, every report filed and
every payment at or above `mica_discord_webhook_payment_min` (`10000` by
default). Posts are batched ten embeds at a time and held to Discord's rate
limit; a failed post is logged once and dropped, never retried. Off by default,
and no player-written text leaves the server unless
`mica_discord_webhook_content` is on — even then only a moderation reason, a
report note or a payment's reason line, never a message body or an image. The
convar table in README has all three.

**qb scripts that mail or notify the phone work unmodified (MICA-222).** micaOS
answers `qb-phone:server:sendNewMail`, `qb-phone:server:sendNewMailToOffline`
and `qb-phone:client:CustomNotification` with the payload shapes qb scripts
already send, landing them on Mail and on the shell's toast. Two things differ
from qb-phone on purpose: the offline form is a local event only, so a client
can no longer mail an arbitrary citizenid, and a mail's `button` is dropped
because micaOS's Mail has nothing to fire. Nothing else under the `qb-phone:`
prefix is answered; the server console lists what is at start, and README's
"Coming from qb-phone" section has the rest.

**The client publishes exports of its own (MICA-224).** `IsPhoneOpen`,
`OpenPhone`, `ClosePhone`, `TogglePhone`, `SetPhoneEnabled`, `GetPhoneNumber`,
`OpenApp`, `Notify` and `GetApiVersion`, callable as `exports['mica']:...` from
any client script, answering the same `{ ok, value }` or
`{ ok = false, reason, message }` shape the server's do. Where a name matches a
server export it is the same concept from the other side, and README's table
says which side is authoritative; `SetPhoneEnabled` from either side sets the
one flag, so a confiscation agrees whoever spoke last. One new reason,
`disabled`, is what `OpenPhone` and `OpenApp` answer while the device will not
open. Nothing on the client is authority, and nothing changes for a script that
only ever called the server.

**`SendMessage(citizenid, message)` is the export that writes such a text
(MICA-223).** It takes the recipient's citizenid and a table with `from` -- a
`name`, a `number`, or both -- and a `body`. It creates or reuses the thread
between the player's phone and that sender, pushes to the app when they are
online and lands in the thread when they are not, and answers
`{ conversationId, messageId, delivered }`. A number a character holds is
refused with `number_in_use`: this export speaks for businesses and lines, not
for players. It is rate limited per calling resource at 120 a minute, and over
that answers a new reason, `rate_limited`, which every caller's error handling
should expect from any export from now on. README's export table has the rest.

**`docs/phone-as-an-item.md` answers the questions the item model raises
(MICA-231):** how a shop sells a phone and what happens on first use, what a
robbery or a trade does to a phone's data (since MICA-438 a thief opens their
own phone and nothing moves), how a confiscation script takes a phone and gives
it back, what becomes of a phone when its item is destroyed, and why the item is
a key and not a phone. Read it before wiring any of those scripts to the item;
the one rule it keeps returning to is that the item carries nothing, so moving,
copying or replacing it changes no one's data.

**A phone number can belong to a script, through three new exports:
`RegisterNumber`, `UnregisterNumber` and `CreateCall` (MICA-226).** A resource
claims a number and answers calls placed to it — a taxi dispatcher, a pizza
line, a 911 desk — where before, any number no character held simply failed as
unreachable. The handler may accept the call, reject it, or forward it to a real
player, and has five seconds to say which; a line is owned by the resource that
registered it and is released, along with any live call on it, when that
resource stops. `CreateCall` places a call as a player, the way a payphone or a
dispatch pick-up would. **No owner action:** nothing changes for a server that
installs no script using them, and micaOS still does not claim the emergency
number itself, precisely so a dispatch resource can. The signatures, the failure
reasons — which have grown `already_registered`, `not_owner` and `number_in_use`
— and the one trap worth knowing (the number must be a string, so
`RegisterNumber(911, …)` from Lua is refused) are in the README's
[Exports for other resources](README.md#exports-for-other-resources).

**The Bank app reads history from okokBanking, and says why it cannot from
qb-banking or ox_banking (MICA-241).** Only Renewed-Banking's transaction export
was read before; every other server saw a balance with an empty list underneath,
which reads as broken. okokBanking's `GetPlayerTransactions` is now read too,
from its published docs rather than source since the script is escrowed.
qb-banking and ox_banking publish no export for their statements — the first
serves them to its own UI over a callback, the second reads its own table — and
micaOS does not read another resource's tables, so on those the app shows
"History not available" with the script's name instead of an empty list, and a
server with no supported banking resource at all says so the same way. **No
owner action.**

**A Jobs app (MICA-228).** A core app that lists every job the character holds,
switches the active one with a tap, toggles duty where the framework has duty,
shows a boss grade its society balance, and lists any number a job script
registered with `RegisterNumber({ job = '…' })` with a call button beside it.
The framework is authoritative throughout: every answer is the list re-read from
the core after the ask, and a switch the core refuses is reported as refused
rather than shown. It refreshes itself when a script changes the player's job
outside the phone. **No owner action**: it is hidden on a standalone server,
which has no jobs, and appears on every other one.

**The phone knows what job a player holds (MICA-227).** The framework bridge now
reads every job a character has — name, label, grade, salary and duty state —
and can switch the active one or toggle duty through the framework's own calls,
never through a micaOS table. On qbx_core that is the core's multi-job model as
it stands; qb-core and es_extended answer their one job, and a multi-job add-on
for either is not read, because those add-ons disagree with each other about
where they keep the list. The server console says which it found at start
(`mica: jobs -> …`). A job's society account is readable through the banking
bridge — Renewed-Banking is verified, qb-banking and qb-management are wired
from their published export names — and a script may now tag a line it registers
with `job` and `label` so the Jobs app can list it. **No owner action**: nothing
is shown to a player until the Jobs app (MICA-228) ships, and a server whose
banking resource has no society accounts answers "unknown" rather than zero.

**The phone can be an item (MICA-229).** Set `mica_phone_item` to the name of an
inventory item and the phone opens only for a player holding at least one: using
the item opens it, the keybind works while they hold one, and losing the last
one closes it the way `SetPhoneEnabled(false)` does, until one is picked up
again. The server counts the item itself on every check, so a modified client
cannot claim one. Empty, which is the default, changes nothing, and standalone
ignores it. **Owner action only if you want the gate:** define the item for your
inventory (README, "The phone as an item"; qb-core and ox_inventory already ship
one named `phone`) and set the convar.

**Every release now attaches the resource itself, prebuilt, as
`mica-<version>.zip` (MICA-220).** Unpack it into `resources` and `ensure mica`:
no Node, no pnpm, no build. It carries the manifest, stamped with the release
version, the built bundles, both schema files, the licence and the installation
section of README. `SHA256SUMS` and the provenance attestation on each release
cover it exactly as they cover the SDK tarballs. Before it is attached, the
release job unpacks it on a FiveM server beside a throwaway database, imports
its own `mica.esx.sql` and starts it; a zip that does not start is not released.
An install built from source keeps working and the resource inside is the same
build, so there is nothing to move to. No owner action.

**The phone speaks the player's language (MICA-61).** Settings > Language lists
every language any app provides, and `Automatic` follows a new convar,
`mica_locale`, then the player's own game language, then English. Set
`mica_locale "de"` (a BCP 47 tag; a value that is not one is ignored with a
console warning) to give a community a default without each player choosing.
Every screen the phone draws — the shell, Settings, the shared dialogs and all
sixteen apps — reads its strings from a catalog, and every one ships German
alongside English (MICA-214, MICA-215). What is still English on a German phone
is the text the server itself composes, such as a refusal in a toast; that is
MICA-216. Dates, times and currency format under the chosen language. A
translator who wants to add a language edits the `locales/*.json` files beside
each app; nothing else is needed.

**What the server says is translated too (MICA-216).** A refusal a service
raises and a toast the server pushes now carry a message key beside their
English, and the phone resolves the key in the player's language; the English
stays as the fallback and as what the server log shows. Three toasts keep their
text as the admin typed it (`micacall`, `micaseed` and the battery command
echo), since it is not fixed prose. No owner action.

**The phone itself now holds what a player consented to when installing an
add-on (MICA-201).** The Store used to be the only witness; the shell now keeps
the accepted permission set per add-on and refuses any call the grant does not
cover, the same way it refuses an undeclared one. Existing installs adopt their
installed manifest as the grant once, at the first boot after updating. An
add-on you push from the server with the `installApp` NUI message is granted its
declared permissions at push time, since you, not the player, are the one
choosing it. No owner action.

**The Messages inbox pages by last-message recency, twenty-five threads at a
time (MICA-211).** It used to walk thread ids two hundred at a time, which could
push an old thread with a fresh message onto a later page. No schema change and
no owner action.

- The lock screen passcode is stored with **scrypt** rather than a single salted
  SHA-256 pass, and wrong guesses are now rate limited on the server rather than
  only in the UI. Two new convars come with it: `mica_lockscreen_scrypt_cost`
  (default `16384`, and it must be a power of two) tunes the hashing cost for
  operators on weak hardware, and `mica_lockscreen_max_attempts` (default `5`)
  sets how many wrong passcodes cost a one-minute lockout. **Nothing is required
  of you** — no schema change, no migration, and no existing passcode to
  convert, since the lock screen has not shipped in a release yet. A salt only
  ever defeated a table built for every player at once; it did nothing for
  anyone holding a single row, for whom ten thousand four-digit candidates
  against a bare digest is a few milliseconds of work.

- micaOS now runs **standalone**, with no framework resource at all, when you
  set the new `mica_standalone` convar. Identity comes from the player's FiveM
  `license:` identifier, so a phone belongs to the player rather than the
  character — the same way it does on ESX. The mode is opt-in rather than
  detected on purpose: "no framework is installed" and "the framework has not
  started yet" are indistinguishable from inside the resource, and guessing
  standalone on a qb server would silently re-key a live database onto license
  identifiers. Setting the convar while a qb or ESX core is present is treated
  as a misconfiguration — the real framework wins and micaOS says so once in the
  console. Standalone servers import `mica.esx.sql`, get micaOS-issued phone
  numbers, and do not see the Bank or Hodlr apps, because there is no money for
  them to move and an app that errors on every tap is worse than one that is
  absent. Marketplace is unaffected. See "Running with no framework" in the
  README for what else the mode gives up. (MICA-151)

- **A deleted Contact, Note or photo can be restored again**, within a shared
  window (`mica_restore_window_days`, default 30 days) after the delete.
  `restore` is a new action on each of the three apps, ownership-scoped the same
  way `delete` already is. Nothing calls it from the phone's UI in this release
  — this is the server half only, and nothing about a deleted row's behavior
  changes if you never wire a "recently deleted" screen up to it. Past the
  window a row is not gone; it is simply no longer reachable through `restore` —
  nothing in micaOS hard-deletes a contact, note or photo, since the moderation
  system depends on a soft-deleted row surviving forever.
- **micaOS runs on ESX.** `es_extended` joins `qbx_core` and `qb-core` as a
  supported framework, detected at start with no convar to set. A player loads,
  sees their own data, and makes a bank transfer (MICA-150).

  Money is handled the way the rest of micaOS handles it — refuse what cannot be
  proved — but it gets there differently, and the difference is one you may see
  in your console. ESX's account calls return nothing at all, so there is no
  answer to judge the way a qb core's `true` is judged. micaOS instead reads the
  account balance before and after the call and refuses unless it moved by at
  least what was asked. If the balance is unreadable beforehand it refuses
  without calling the framework. If it was readable before and is not after —
  rare, and it means something changed underneath — it refuses, logs a
  `[FrameworkBridge]` line saying so, and tells you to **reconcile that account
  by hand**, because in that one case the money may genuinely have moved.

  **Import `mica.esx.sql`, not `mica.sql`.** There are now two schema files,
  both generated and both creating the same twenty-nine tables. The ESX one
  carries none of the foreign keys onto `players`, because ESX has no such table
  — it keeps players in `users`, by `identifier`. Importing the wrong file fails
  at the first foreign key rather than half-working.

  Four ESX limitations are worth knowing before you install, all of them
  documented under **Housekeeping on ESX** in the README. Nothing cleans up
  after a deleted character, so wiring your deletion flow to
  `mica:server:media:characterDeleted` is not optional there the way it is on a
  qb core. Phone numbers are not part of core ESX, so a player whose number
  lives somewhere micaOS does not look will have no number and no number-based
  lookup — and an **offline** player is found by identifier but never by number,
  core ESX having nowhere to keep one. And the battery level micaOS mirrors onto
  the framework player, for other resources to read, degrades on older ESX
  builds and is dropped with a logged warning on builds offering nowhere to put
  it — the phone's own battery is unaffected in every case.

- Proximity music, which lets a phone play out loud to the people standing
  around it, is bounded by two new convars: `mica_music_range` for how far it
  carries, and `mica_music_max_nearby` for how many broadcasters one listener is
  told about at once (MICA-111).
- `mica_camera_quality` sets how hard a photo is squeezed before it is stored,
  for an owner trading picture quality against database size.
- A Bluetooth proximity share now reaches at most five phones, nearest first,
  set by the new `mica_bluetooth_max_nearby` convar. It was previously everyone
  in range, however many that was, and a photo drop writes each of them a full
  copy of the photo. Raise it if your server's idea of "nearby" is a whole club;
  the ceiling is 16 (MICA-115).
- A photo larger than 4MB is refused rather than stored. The column holds 16MB
  and nothing checked against anything smaller, so a modified client could fill
  `mica_media` far faster than any camera can. Nothing the phone's own camera
  produces comes close to the cap — `mica_camera_quality` is still the knob for
  how big stored photos actually get (MICA-116).
- Each player's photo library now has a ceiling, set by the new
  `mica_media_quota_mb` convar and defaulting to 64MiB — roughly 150 to 200
  captures. Over it, a photo is refused with a message that says the library is
  full; deleting something frees the room immediately. A proximity share checks
  each recipient too and skips anyone with no space, so nobody is pushed over
  their ceiling by somebody else's gesture (MICA-71).
- `mica_media_retention` deletes stored media older than a number of days you
  choose. **It is off by default and it deletes rows permanently**, so it
  changes nothing until you set it. It runs at resource start and on the new
  `micamedia prune`, which is console-only for the same reason
  `micaschema apply` is. `micamedia` with no argument still only reports
  (MICA-71).
- A deleted character's photos are cleaned up rather than left behind. The table
  already cascades off `players`, and now a sweep at every resource start also
  removes media whose owner no longer exists — for installs whose table predates
  that constraint — while a deletion script of your own can trigger
  `mica:server:media:characterDeleted` with a citizenid to reclaim the space at
  once (MICA-71).

- `mica_hodlr_trade_max` caps what a single Hodlr buy or sell can be worth,
  defaulting to 50,000 — the same number and the same shape as
  `mica_bank_transfer_max`, which was until now the only value cap on the phone.
  Nothing bounded a trade before, so one request could convert a whole bank
  balance into coin or a whole holding back into money (MICA-130).

On the question behind all of that: **photos stay base64 in MySQL.** A FiveM
resource has no static file host it can safely write to, one database backup
still restores the whole phone, and CEF renders a data URI without a second
fetch — so the fix for a table that grew forever is bounds on it, not a
different place to put it. The day micaOS stores real video that answer changes,
and that will be its own release note.

Their defaults, and which of them need `setr` rather than `set`, are in the
README's [Configuration](README.md#configuration) section — the distinction
matters, because the two that the game client reads are silently ignored unless
they are replicated.

**The battery bank is now a server owner's choice, through `mica_battery_item`
and `mica_battery_item_charge` (MICA-257).** The first names the inventory item
that recharges a phone — `battery_bank` by default, as before — and the second
says how many percent one use adds, 100 by default. Set the charge to 25 and a
bank becomes a partial top-up worth carrying several of; set the item to `""`
and nothing but a charger, `SetBatteryLevel` or `micacharge` refills a phone.
**No owner action:** the defaults are exactly what the item did before. Nothing
ships a `battery_bank` item definition, so the README's
[battery bank](README.md#the-battery-bank) section has one to paste for
ox_inventory, qb-core and ESX, beside the phone item's.

**The undocumented net event `mica:server:battery:useItem` is gone.** It spent
an inventory item on a raw event any client could emit, nothing in micaOS ever
emitted it, and the framework's usable-item callback — which alone can say the
item was in _that_ player's inventory — did the job properly. A script that
somehow emitted it should call the `AddBatteryCharge` or `SetBatteryLevel`
export instead, which authenticates its caller.

### Fixed

**On ESX, a new character in a deleted character's slot gets a phone of its own
(MICA-440).** esx_multicharacter gives the next character in a slot the deleted
one's identifier, `char<slot>:<license>`, and micaOS kept a deleted character's
phone, lock-screen passcode and battery live, so the new character opened the
old phone and could meet a passcode they never set. Deleting a character now
erases those three with the rest of its rows, on every framework, and the
start-up sweep does the same for a character it finds gone. A qb or qbx
character's micaOS number stays live, so it is never issued to anyone else.
Nothing to do on the server, but on ESX fire
`mica:server:shell:characterDeleted` from your deletion flow: a slot reused
before the next restart holds a character that exists again, so the sweep cannot
see that anything was deleted, and the new character inherits the old one's
phone and everything on it.

A character the framework no longer has is no longer given a new phone by an
export that names it, because on ESX that phone would be the next character's in
the slot. `SendNotification` drops the notification with a line in the console,
and `AddContact` and `AddMedia` answer `unknown_player`, as `SendMessage` and
`SendInvoice` already did; nothing is written. If micaOS cannot tell, because it
cannot read the character table or the orphan sweep would not trust it, it
creates the phone as before and says so once. Standalone, which has no character
table, is unchanged.

**A Store add-on can no longer run code its pin never covered (MICA-442).** An
add-on's frame allowed scripts and stylesheets from any `https:` or `http:`
host, so a bundle whose SHA matched the catalog could `import()` more code from
anywhere and run it, or carry a player's data out in a script or stylesheet URL.
Scripts and styles now load only inline, from `data:`/`blob:`, or from a host
the add-on's manifest declares, the rule images, media and fonts already
followed (MICA-202). Nothing to do on the server.

**A Store add-on can no longer send a player's money anywhere (MICA-441).** A
`core: false` add-on that declared `bank` could call `sendMoney` and
`payInvoice` from its frame once the player had accepted "Send Money" on its
permission sheet, so an add-on's bytes, chosen by whoever controls its catalog
host or its author's account, decided where a player's balance went. Only a core
app may declare `bank` now: `defineApp` refuses it on an add-on's manifest, at
its build and at install, and the shell shuts a frame whose manifest declares it
before anything answers. Reading a balance stays on `account`. Nothing to do on
the server.

**A citizenid, a phone's device id or another player's number no longer leaks to
other players, add-ons, the console or Discord (MICA-433).** On ESX a citizenid
is the player's Rockstar licence, so this mattered most there.

Before, sending $1 to any phone number answered with the citizenid of whoever
held it, and an open invoice carried the biller's. Every reply about a player's
own data also carried their citizenid and device id, which reached any add-on.

Now the server strips both from every reply and every push to a phone. The phone
itself never asks for the player's citizenid any more. A nearby stereo no longer
shows the broadcaster's character name, and the Bank card shows a masked number
instead of one derived from the citizenid.

The console no longer logs a payment that went through, or which character holds
which number or phone. Every failure line that has to name a player prints a
short, stable token instead, the same token everywhere, so staff can still match
lines up. A database error no longer prints its query or a colliding value.
Discord embeds name players by that token too, unless
`mica_discord_webhook_content` is on.

The salt behind the tokens is minted once per install into
`mica_schema_migrations`. It needs no migration and no new convar.

A wallpaper photo now shows only for the character who set it. Every photo set
before this update falls back to the default once, until it is picked again.

**Content a moderator takes down and later reinstates comes back where it was
and as it was (MICA-426).** Reopening a report puts the content back in its old
place, unchanged. Before, a takedown or a restore marked a text, a Blab or a
Glimpse post as edited, and re-dated a photo in Recently Deleted. A text taken
down in Messages also stayed visible in the thread and the inbox, so there was
nothing to reinstate.

Taken-down content is now kept as evidence while it stays taken down. No
retention window, Dark Chat sweep or purge removes it, and that includes a
player's own privacy delete. Before, retention could delete it once the report
was acted on, and a later reopen found nothing.

A purge now hides what it has to keep instead of leaving it live. That covers a
character delete, the start-up sweep and a player's privacy delete, and it hides
the player's Blabber or Glimpse account when a kept post names it. A player's
deletion during a takedown wins, so a reopen restores the content as deleted.
That includes a Spark profile removed or a Spark match ended. A reopen that
cannot bring the content back now tells the admin so in words, and the report
stays as it was.

A Marketplace listing that was sold or removed and is kept this way is recorded
as deleted. The change needs no migration and no convar.

**A direct message can be read again on a server with a content key
(MICA-390).** Since `v2026.10.15.54`, opening a thread or the inbox in Blabber's
direct messages on a server with `mica_content_key_file` set answered "Something
went wrong": the read left out the column a sealed body's authenticated data is
bound to, so every sealed body refused to open. The rows were never damaged and
nothing needs re-sealing; they read as before once the server is updated. A
server with no content key was not affected. Found by the in-server suite the
first time it drove the service as a player, not by any unit test, and the unit
test that let it through now cuts each stored row to the columns the handler's
query names.

**A repeated ear, follow, block, reaction or handle claim no longer answers
"Something went wrong", and nor do two texts opening the same thread at once.**
oxmysql's error object is created in its own resource, so the check micaOS used
to recognise a duplicate-key failure never matched it in game: a second ❤️ on
the same post or message, an ear, follow or block already in place, a handle
already taken, or two first texts racing to create one 1:1 or one business-line
thread all reached the player as the generic error. Each now answers as a single
attempt does — the reaction counts once, the ear, follow or block stays, the
handle claim says the handle is taken, and both texts land in the one thread.

**A database failure now logs the driver's reason instead of nothing.** For the
same cause, every place the server wrote a failure's reason to the console — the
notification batch, the Casino, Spark, Reports, Dark Chat, the schema tools, the
importer, outbound HTTP, the Discord webhook and the retention sweeps —
recognised only an error made in micaOS's own realm, so an oxmysql failure
logged an empty reason or "unknown database error". Each now logs the driver's
own last line (a lock wait timeout, a missing table, a refused connection) and
no longer the statement or its parameters, which carried message bodies and
citizenids on the few paths that printed the whole error. Nothing a player sees
changes; the fix is for whoever reads the server console. Nothing is written
twice.

**`micaschema apply` now creates a table that does not exist yet (MICA-388).**
It creates a new app's table, its child tables and the audit ledger, in
foreign-key order and in the same shape a fresh install gets, before it adds
missing columns and indexes. Before, it created nothing and still said the
schema was up to date. So a server that updated past a release adding a table
never got it, although the entries for those releases told you `apply` would
create it. `micaschema plan` now lists such a table as `create table …` instead
of telling you to import `mica.sql`. If you ran `apply` for an earlier release
that added a table, run it again: it creates whatever is still missing and
changes nothing else.

**`micaschema apply` alone now finishes a first-start create that stopped
part-way (MICA-389).** Migrations 0001, 0002 and 0003 used to stop on a table
that did not exist yet, so `apply` failed before it reached the tables it now
creates. They now skip a missing table, still record themselves, and leave the
create to build it in its current shape. A database with `mica_contacts` but no
`device_id` column and no `mica_phones`, as an old re-import leaves it, still
stops at 0002 as before. The start-up message for a half-created database now
says to run `micaschema apply` and restart, not to import `mica.sql` first.

**A text into a 1:1 nobody else is in is refused, and the thread says so
(MICA-349).** After the other side left a 1:1, or was taken out of it by a
privacy delete, or when a 1:1 was started to a number nobody holds, a text typed
into it was stored and reached nobody, and the sender saw it as sent. The thread
now shows "No one else is in this conversation." where the text field was, and
the server refuses such a send with the same words, writing nothing. The thread
stays readable, and starting a new 1:1 with the same number works. A group is
never refused, even with one member left, and nor is a thread with a business
line.

**A phone with no number of its own no longer gives away its holder's main
number (MICA-346).** On qb and standalone, a call, a text, a forwarded call's
Recents entry and a shared live location from a phone that had no number yet
carried the holder's main number instead. Each now waits for the phone's own
number and, if it still has none, refuses: the player sees "This phone has no
number yet." and nothing is sent. A listing from such a phone shows no Call or
Text button. A player holding no phone at all now sees "You are not holding a
phone" when dialling. On ESX a phone's number is the character's, so the leak
never happened there, but a character with no number could still text, and
nobody could block a text that carried no number: such a text is now refused the
same way, as its calls already were (MICA-348).

**A security review closed a set of privacy and authority gaps (MICA-339).** No
schema change and no command to run. What players and scripts notice:

- **On a server that sets `mica_phone_item`, the server now refuses some actions
  from a player holding no phone**, instead of trusting the player's client:
  sending money, paying an invoice, trading on Hodlr, posting a listing or a
  Blab, sending a message or a Blabber DM, and starting a music broadcast. They
  get the usual "You are not holding a phone" toast. Reading is unchanged, so a
  phone-less player's phone still starts. **`CreateCall` for such a player now
  answers `caller_has_no_phone`**, and a call shows the number of the phone
  actually in hand.
- **Messages no longer tell one player another's character name or main
  number.** People show as the reader's saved contact, else their number, and a
  new 1:1 thread is named the same way. A thread shows the other phone's own
  number. 1:1 threads created before this keep the other player's name in the
  database, but it no longer leaves the server.
- **A player can report, and react to, only what they can see**: a message in
  their own thread, a DM they sent or received, a photo they own or can see
  attached, or a public post that is still up. Anything else is answered as if
  it did not exist.
- **A photo moderated or deleted after it was attached stops showing** on Blabs,
  listings and messages, and can no longer be attached again.
- **A photo a player saves must be an image, not a link**, so a shared photo can
  no longer make every viewer's game fetch somebody else's server. The same goes
  for a Blabber avatar, including one brought in by `micaimport`, which now
  keeps only an image and drops a link. Wallpapers take only an image or an
  `https` address, escaped.

**A failed battery read no longer resets a phone to 100% (MICA-325, MICA-326).**
When the database could not answer at load, micaOS treated the phone as having
no saved charge and wrote 100% over it. A read error now writes nothing and is
retried about once a minute, and a battery bank used meanwhile is refused with
the item kept. **`GetBatteryLevel` and `AddBatteryCharge` now answer
`{ ok: false, reason: 'internal_error' }` on a database error** where they used
to answer 100 (and `AddBatteryCharge` wrote 100 plus its delta); both already
listed that answer, so a script that checks `ok` needs nothing. A battery bank
is also refused, and kept, when ox_inventory's `RemoveItem` fails or answers
`false`, on qb, qbx and ESX alike; it used to charge anyway. Nothing to do.

**Another script could take a resource's phone numbers or invoice callbacks by
faking its stop (MICA-308).** micaOS released everything a resource held through
`RegisterNumber`, and the `onPaid`/`onDeclined` callbacks it gave `SendInvoice`,
whenever `onResourceStop` named that resource. Any server script can fire that
event, so one could release a dispatch script's 911 line and register the number
itself. micaOS now honours a stop only when the resource is actually stopping.
Nothing to do.

**On standalone, looking up a player who is not connected no longer logs an
error.** A lookup for a server id nobody holds printed a console error claiming
the framework "returned a player" for it, once per check, and some exports check
more than once. It is now a quiet "no such player", as on qb and ESX; a player
who is connected but cannot be identified is still reported.

**Messages and Blabber posts brought across by `micaimport` no longer read as
edited.** The import kept each row's original time as `created_at` but let
`updated_at` default to the moment of the import, and the app marks anything
whose `updated_at` is later than its `created_at` as edited. Both now carry the
source's time. Rows imported before this fix still show the mark.

**Re-importing `mica.sql` or `mica.esx.sql` over an existing database no longer
marks every migration done without running it (MICA-301).** The file now records
the migrations only when it created micaOS from nothing; over an existing
database it records none, and the next `micaschema apply` runs the ones your
database has not had, each doing nothing where its change is already in place. A
database re-imported before this fix may carry records for migrations that never
ran: 0006 is caught regardless (`apply` and the start-up warning check for its
keys directly), and for 0004 and 0005 `micaschema` reports the missing change as
drift. No owner action unless it does.

**With an external image host, hosted photos count against the media quota, and
are no longer offered as wallpapers (MICA-293).** A hosted photo used to cost
only its thumbnail, so `mica_media_quota_mb` stopped bounding uploads to your
host. Each now counts at the size it was uploaded at, or 320KiB for photos
hosted before this release, and `micamedia` reports the same figure. **A player
who already holds more hosted photos than their quota allows cannot take new
ones until they delete some**, and is told so before anything is uploaded;
`micaimport` likewise charges a photo link on your image host 320KiB, so an
import can now stop at the quota where it used to bring every link over.
Settings no longer lists hosted photos as wallpaper choices, which used to fail
with "That photo has no image data", and an add-on setting one as a wallpaper
gets an error rather than nothing. A proximity share can no longer give
recipients a photo whose file retention had just deleted. No owner action.

**On ESX with MariaDB 11.4 or later, the orphan sweep works again, and
`micaschema apply` no longer refuses over the `users` collation (MICA-299).** A
`users` table on MariaDB 11.4's default collation (`utf8mb4_uca1400_ai_ci`) made
every orphan-sweep statement fail with "Illegal mix of collations", so nothing a
deleted character left behind was cleaned up, hosted photos included. The sweep
now matches whatever collation `users` is on, and `micaschema apply` no longer
refuses an ESX server over it; the check on qb's `players` is unchanged. A table
the sweep cannot clean is now logged as a failure at start and by
`micamedia prune`, which used to report zero instead. No owner action.

**Hanging up now leaves the voice call on the side that hung up.** The server
only tells the other party a call has ended, and only that message took a player
out of the pma-voice call channel, so the player who pressed end stayed in it.
The server now tells both parties, however the call ended — hanging up, a flat
battery, or a disconnect. No owner action.

**A character switch no longer carries the last character's phone settings over
(MICA-287).** The phone caches settings in the client's browser storage, and a
character load only ever added the new character's rows to that cache. A
character with no saved dock therefore kept the previous one's, and
`mica_default_dock` never showed for them. The same went for every other
setting, add-ons included. A character load now removes whatever the new
character's saved settings do not include. A setting changed in the last moment
before a reload is kept, and so is anything an app deliberately stores per
device. No owner action.

**Every raw net event declares its arguments as a schema before its handler runs
(MICA-210).** The five fire-and-forget events outside the contract mechanism —
`phone:*`, `battery:*`, `signal:*`, `admin:setBattery` and `contacts:share` —
each parsed their positional scalars by hand. `guardNetEvent` now takes a tuple
schema and refuses a payload that fails it, silently, as the guard always did;
the census test fails on a raw handler with no schema. Three edges tightened:
`setBattery` parses before the admin check, so a non-admin sending garbage is
dropped rather than toasted; a shared card with a non-string name or number is
refused instead of coerced; and `simulateIncoming` refuses a non-string instead
of defaulting.

**On ESX, an offline player can now be found by phone number (MICA-225).**
Before, `GetCitizenId(phone)`, `SendSystemEmail` to a number nobody online held,
and sharing a contact who was offline all silently did nothing on es_extended,
because core `users` has no phone column and micaOS declined to guess which
community resource had added one. It now asks the database once at start which
of `phoneNumber`, `phone_number` or `phone` the table has and reads through that
column, printing which in the console. **No owner action**: a `users` with none
of the three behaves exactly as before, and says so once at start.

**Ending a `micacall` test call knocked every player on the server out of their
own call (MICA-277).** The injected call's caller is the console, kept as server
id `-1`, and in FiveM emitting to `-1` reaches every connected client — so when
the target hung up, the "you have been ended" event went to the whole server,
and answering one put every client into the voice channel. Both events are now
sent only to a side somebody is actually connected on. No owner action.

**On ESX the Messages app opened empty: the conversation list joined a `players`
table es_extended does not have, and the query threw.** Names now come from the
framework's own character table, by parameter rather than by join (MICA-197).
The same pass takes the list from one query per thread to three for the whole
page, delivers a group message with one player lookup and one block check
instead of one of each per recipient, and stops rendering a missing contact name
as the text `null`. The list is paged at 200 threads per read; nobody reaches
that today and no owner action is needed.

- Add-on bundles carried a fabricated version. `vite.addon.config.ts` had no
  `define` block, so `__MICA_VERSION__` was never substituted and every add-on's
  `MICA_VERSION` fell through to a hard-coded `1.0.0` — on every server,
  forever, while the phone's own bundle carried the real CalVer. The one version
  number an add-on could read was wrong in exactly the bundles that needed it,
  and it was wrong in the shape that reads as success rather than as an error.
  **If you author an add-on, note the new value is the empty string, not the
  real version**: a bundle is compiled once and then installed by whatever phone
  fetches it, so the host's build stamp is not knowable when the bundle is
  written, and baking in the building tree's number would be accurate for the
  four add-ons that ship here and a lie for everyone else's. Guard with
  `if (MICA_VERSION)` before using it. (MICA-170)
- `@mica/sdk` now exports `SDK_CONTRACT_VERSION`, which is the number an add-on
  actually wants: it moves when the SDK's surface changes, never when the phone
  rebuilds. It existed before as a constant inside a test file, where nothing
  could import it. Nothing about a server changes. (MICA-173)

- **A framework that stops answering money calls the way it used to can no
  longer create currency.** micaOS asks your framework to debit and credit
  players, and it believed whatever came back. If a qb-core or qbx_core release
  made `RemoveMoney` asynchronous — an ordinary thing for a resource to do — the
  pending answer read as a completed debit, and the person being paid was
  credited whether or not the payer was ever charged. Same shape for a balance:
  a lookup that answered with anything but a number compared as "can afford it",
  and the spend went through. micaOS pins the FiveM runtime exactly and cannot
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
  `mica_hodlr_price_history` from a backup reopens it with no restart. The
  hourly pruning sweep also now keeps the newest row whatever its age — it is
  the price, not a chart point, and a server that had been down longer than the
  retention window used to delete it (MICA-130).
- **A database that stops answering mid-restore no longer wedges the market
  shut.** `restart oxmysql` while Hodlr was reading its price left a promise
  that never resolved, and the market stayed closed for the life of the resource
  — every trade refused, chart flat, only `restart mica` to recover. An
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

**Using a battery bank appeared to work and then silently undid itself
(MICA-257).** The recharge set the phone's display and the stored row but never
the live value the server's drain loop ticks from, so the next tick pushed the
old low charge straight back over the 100 the player had just spent an item for.
It goes through the same one-way-in that `micacharge` was moved onto, so all
three copies of the number agree.

**A battery bank could be spent by a source with no loaded character, and pay
out anyway.** The inventory removal answered "removed" when there was no player
to remove it from, which meant the charge was granted without the item ever
being held. It fails closed now.

### For add-on authors

Everything above is written for a server owner. This part is not. It is for
somebody maintaining a `core: false` add-on outside this repo, and it answers
one question: does that bundle still compile against this release, and does its
manifest still ask for the right things.

**A contact's number can no longer be used as a filter (MICA-432).** It is
sealed now, and the server looks it up through a keyed index, so `phone` is no
longer a filter a `contacts` read accepts. Fetch the contacts and match on the
phone instead.

**`useSearchProvider` now needs the `search` permission (MICA-433).** The shell
hands every search provider the player's query one keystroke at a time while the
app runs, which no consent screen used to mention. Add `'search'` to
`permissions`; the Store asks for it as "Read What You Type in Search". An
add-on that calls `useSearchProvider` without declaring it throws
`AppPermissionError`, and the add-on build's permission scan refuses it.

**An add-on no longer sees a player's citizenid, device id or the moderation
queue (MICA-433).** `useAccount` no longer has `citizenid` or `fetchCitizenId`
at all, while the phone number, balance and transactions stay behind `account`.
`admin` is refused on a `core: false` manifest, at `defineApp` and again by the
shell before any facet answers, so `useAdmin` and `useReports` give an add-on
nothing. The shell also removes every `citizenid` and `device_id` field, at any
depth, from everything it posts to an add-on's frame, its own service's rows
included. The server no longer sends them on a player's own rows either, and
`Invoice` loses `payee`. An add-on that read any of these stops compiling or
sees the field gone, and there is nothing to replace it with on purpose: on ESX
a citizenid is the player's licence. The contract version stays `1`, since
nothing outside this repo builds against it yet.

**An add-on can no longer move a player's money (MICA-441).** `bank` joins
`admin` as core only: `defineApp` refuses it on a `core: false` manifest, the
add-on build's permission scan refuses `useBank`, and the shell shuts a frame
whose manifest declares it before any facet answers. `useBank` gives an add-on
nothing, so `sendMoney` and `payInvoice` stop compiling. Show a balance through
`account`, which is unchanged. An add-on with its own server service still
spends inside that service's own rules, as Casino and Hodlr do. The contract
version stays `1`.

**Scripts and stylesheets load only from a host your manifest declares
(MICA-442).** The frame's `script-src` and `style-src` no longer admit any
`https:` or `http:` host: they are `'unsafe-inline'` (and `'unsafe-eval'` for
scripts), `data:`, `blob:` and your `networkHosts`. An add-on built with the
template is one inlined module with its CSS injected as a `<style>`, and is
unaffected. One that loads a script or stylesheet from a CDN stops loading it:
bundle it, or declare the host in `networkHosts` (with `requiresNetwork: true`),
which the Store shows the player.

**A manifest's `color` is gone: write `tile`, and read `tile` (MICA-419).**
`defineApp` used to accept the old `color` string beside `tile`, and every
manifest it returned carried a `color` derived from the tile. Both are removed.
`tile: { bg, fg? }` is now required, and a manifest that still sets `color`
fails `defineApp` with an error naming it, with or without a `tile`. Code that
read `manifest.color` reads `manifest.tile`, and `flattenTile(tile)`, now
exported, gives the same class string `color` used to. The Store catalog's own
`color` field is a wire format and is unchanged. As with the removals below,
`SDK_CONTRACT_VERSION` stays `1`, because nothing outside this repo has built
against it.

**`GphoneSchema` in `@mica/shared/schema` is now `MicaSchema` (MICA-422).** It
is the same type under the product's name, with no alias left behind. An add-on
that names the old type changes the one word.

**Four names leave the `.` entry, and `SDK_CONTRACT_VERSION` stays `1`.**
`onAppMount` is gone. It ran a handler when the component mounted, which is what
the app rules say never to do — apps are resident and mount once per session —
so load with `onAppForeground` instead. `hydrateSettings`,
`registerPersistedReset` and `registerPersistedRehydrate` were the shell's own
persistence plumbing, exported with no permission behind them and never meant
for an add-on; the shell now reaches them by path and they are no longer on
`@mica/sdk`. A removal would normally move the contract number, and for one
afternoon it did; SDK 1 has not been released and nothing outside this repo
consumes it, so the number stays `1`, the public catalog stays at
`addons/sdk-1/catalog.json`, and no stamped add-on is refused. A bundle that
imported none of the four compiles unchanged.

**Five writes leave the add-on rows of `mail`, `messages` and
`lockScreenWrite`.** `addReceivedMail` and `addReceivedMessage` wrote the
phone's own inbox with no server behind them, so a frame could plant mail or a
whole thread from any number, under the name the player saved for it.
`setPasscode`, `clearPasscode` and `setAutoLockPolicy` could remove the player's
passcode, or replace it with one they do not know, because the server never asks
for the current one. A call to any of the five now fails at the shell with "core
only", as a `keybindsWrite` call already did. The permission names are unchanged
— `lock-screen-write` now grants an add-on nothing — and the types stop offering
the five in a later entry below.

**What a frame receives is now plain data.** A store value pushed into an
add-on's frame is projected before it is posted: functions and components are
left out (a key is dropped, an array slot becomes `undefined`), `Date`, `Map`
and `Set` keep their shape, and an `Error` arrives as `{ name, message }`.
Before, a value carrying a function — every registry manifest's `icon`, every
toast's `onClick` — failed to clone and stopped every store in the shell until
the page reloaded. If your add-on read `icon` or `onClick` off a pushed value it
was unusable already; it is `undefined` by design now.

**`lifecycle.currentApp` shows your own app only.** In a frame it carries the
shell's value, props included, while your app is in front, and
`{ id: '', props: {} }` otherwise; it no longer says which other app the player
opened. `onAppForeground` and `useAppVisible` behave as before. An add-on that
needs the foreground app's id declares `navigation` and reads
`useNavigation().currentApp`.

**Notifications are filed under your app, and `usePhoneNotification` takes an
app id.** `usePhoneNotification(appId)`: the argument is optional for a core app
(omitted, its notices file under `system`) and ignored in a frame, where the
shell pins it to the add-on. From a frame, `sendNotification` always files the
toast and the drawer row under your id; `type` is one of `info`, `success`,
`warning` or `error` and anything else becomes `info`, so a frame cannot raise a
call banner; the notice counts as an app notification, so Do Not Disturb and the
player's per-app mute hold it; a duration of `0` no longer keeps it on screen; a
repeat title folds only into your own earlier toast, never another app's;
`toast` lists your own toasts only; and `dismissNotification` ignores an id that
is not yours. Nothing in an add-on's code has to change; a frame that passed
`type: 'message'` to land its row in the Messages drawer no longer can.

**`createCrudStore` and `createPagedStore` gain `error`, and a frame's
string-form store without `service` fails at construction.** `error` is a
`Readable<string | null>`: a failed read sets it to the failure's message and
the next answer clears it, so a component tells "still loading" from "the server
refused" by `error`, never by an empty list; `load()` still resolves. In a
frame, `createCrudStore('journal', { list: 'get' })` with no `service` used to
hang on its skeleton forever, because the sandbox has no NUI action names; it
now throws at construction with a message naming the option, so a store built at
module scope stops the add-on from booting where before one list stayed blank.
The phone's own stores are unchanged, and nothing was removed.

**Add-on hook types now offer only what an add-on can call, and four permissions
are refused in a `core: false` manifest.** Ten hooks on the add-on barrel —
`useAppRegistryWrite`, `useSystemHardwareWrite`, `useNotificationSettingsWrite`,
`useLockScreenWrite`, `useKeybindsWrite`, `useDisplayWrite`, `useLocale`,
`useStreamerMode`, `useMail` and `useMessages` — are retyped without the 34
members the shell answers "core only"; they compiled before and always failed at
runtime. Core apps keep the full types. A `core: false` manifest declaring
`app-registry-write`, `keybinds-write`, `lock-screen-write` or
`notification-settings-write` is refused by `defineApp`, naming them, in its own
build and at install, and a saved remote add-on that declares one is dropped at
start-up with a warning. The template's permission scan says such a hook "is
core only" and to stop importing it, where it used to ask you to declare the
permission. The contract number does not move, for the reason given above.

**An add-on's id is `lower_snake_case`, and twenty-one ids are reserved.**
`defineApp` refuses a `core: false` manifest, remote included, whose id is not
`[a-z][a-z0-9_]*` after lowercasing (`a:b`, `my-app` and `1st` are refused;
`MyApp` is accepted as `myapp`), or whose id is `home`, `system`, a core app's
id (`bank`, `settings`, …), or one of the server services that have no app of
their own: `accounts`, `admin`, `battery`, `blocklist`, `conversations`,
`devices`, `dms`, `highscores`, `importledger`, `integration`, `invoices`,
`lockscreen`, `notifications`, `phone`, `phonenumbers`, `privacy`, `reports`,
`shell`, `signal`. Such an id would read as a screen the phone already has, or
claim a service namespace the add-on does not own. The Store refuses the install
before fetching anything, and a saved add-on with such an id is dropped at
start-up with a warning. Core manifests behave as before.

**`DmInbox` and `DmThread` are new components (MICA-392), behind `social` and
`app-events`.** `DmInbox` lists an app's DM correspondents newest first and
reads again on a live `dm` push; `DmThread` pages one thread from the newest
end, marks it read on open, sends, and shows a failed send inline rather than as
a toast. Both go through `useDirectMessages`, so a manifest that already
declares `social` and `app-events` needs nothing more. Nothing was removed, and
`SDK_CONTRACT_VERSION` stays `1`.

**`useDirectMessages(appId)` is new, behind the existing `social` permission
(MICA-390).** Private one-to-one messages between two accounts in your app:
`threads()` lists every correspondent across your accounts there,
`thread({ account_id, peer_account_id, cursor, limit })` reads one newest first,
`send({ account_id, peer_account_id, body })` and
`markRead({ account_id, peer_account_id })` write. Reads answer empty on failure
and writes reject. The server refuses any app that has not registered a DM
policy, and in a frame the app is always your own. The types are `DirectMessage`
and `DirectMessageThread`. Nothing was removed, and `SDK_CONTRACT_VERSION` stays
`1`.

**An add-on can ship a separate tablet root (MICA-265).** `bootAddOn`'s options
take an optional `tablet` root, which it mounts instead of the main one while
the tablet is on screen. The template's build passes `src/tablet.svelte` when
the file exists. A tablet root needs `display` in the manifest's `permissions`,
and the build refuses one without it. This is additive, and the contract version
is unchanged.

**`ReportDialog` and a single-select `PhotoPickerModal` no longer throw inside
an add-on's frame (MICA-254).** Both confirmed by calling the toast store's
`show`, which the sandboxed frame does not have, so a report was filed and the
dialog then threw `show is not a function`. Inside a frame they now confirm
through `sendNotification`, which the `notifications` permission they already
need covers. The toast shows no app icon there. Nothing in an add-on's code has
to change.

**`PhotoPickerModal` now needs `notifications` as well as `media`.** It always
called `usePhoneNotification`, so an add-on that declared only `media` passed
the manifest scan and then threw `AppPermissionError` when the picker mounted.
The scan now asks for both. Add `notifications` to `permissions` if you render
the picker; `ReportDialog` already needed it. The contract version is unchanged.

**Reads that fail now say so instead of answering empty (MICA-384).** These now
reject when the request fails or the reply is malformed, where they used to
resolve with an empty value that looked like a real answer:

- `useAccounts`: `getMyAccounts`, `getAccounts`, `getFollowStats` and
  `getReactionsFor`;
- `useHighscores().getLeaderboard`;
- the Recently Deleted reads, `getDeletedContacts` and `getDeletedMedia`;
- the messages facet's `loadMessageReactions`.

Catch the rejection and keep what you are showing; an empty array or `{}` now
always means the server said so. `createCrudStore` and `createPagedStore` no
longer set `loaded` after a failed load, and a reply that is not a list counts
as a failure, so a list stays in its loading state and the next load retries.
`usePagedList` now clears `loading` after a page that rejects. No signature
changes, so `SDK_CONTRACT_VERSION` stays `1`.

**A leaderboard entry no longer carries a citizenid (MICA-343).**
`LeaderboardEntry`, which `useHighscores().getLeaderboard` returns, drops
`citizenid`; the name and score stay. Key a list of entries by its position
rather than by `citizenid`, which is now `undefined` on every row and would give
Svelte a duplicate key. SDK 1 has not been released, so `SDK_CONTRACT_VERSION`
stays `1`.

**Messages no longer carry other players' ids (MICA-339).** `UIConversation`
drops `citizenid`, `participant_a` and `participant_b`; `UIMessage` drops
`citizenid`. Use `UIMessage.mine` (the reader sent it) and `UIMessage.sender_id`
(the sending member's `participants[].id` in that thread, or `null` for a line
or a member who has left) instead of comparing citizenids. Each of
`participants` is `{ id, role, status, last_read, self, phone }`: `self` marks
the reader's own membership, and `phone` is the number on the phone in the
thread; it no longer has `citizenid`, `phone_id` or a `contact`, so name a
member from your own contacts by `phone`. `IncomingMessage` gains `sender_id`,
and its `senderName` is set only for a text from a line. A wallpaper set through
`useWallpaperWrite` must be an inline image or an `https` address with no quote,
bracket or whitespace, or the call rejects, and `MediaThumb` draws `data` only
when it is an inline `data:image/`. SDK 1 had not been released, so
`SDK_CONTRACT_VERSION` stays `1`.

**A server refusal now keeps its key (MICA-310).** When the server refuses
`useService(...).call(...)` with a catalog key (`server.rateLimited`,
`server.notAuthenticated`, `server.endpoint.appDisabled`, `server.generic`), the
promise rejects with a `ServiceRefusal` carrying that `key`. The message is
translated exactly as before. Test it with `isRefusal(error, key)`, new on
`@mica/sdk`, rather than comparing the translated message, which differs by
language. Your own `addonError(...)` refusals are still a plain `Error`.
Additive only; `SDK_CONTRACT_VERSION` does not move.

**`createCrudStore` and `createPagedStore` take your service declaration
(MICA-313).** `createCrudStore(notes, { list: 'list', create: 'add' })` and
`createPagedStore(notes, 'page')` check every action name against your
`defineAddonService` declaration and type the rows from the list action's
`addonOutput<Row[]>()` and the draft from `create`'s input, with no type
argument to assert. The forms that take a `service` string are unchanged, and
nothing you compile against today changes.

**`pnpm check` in the add-on template now fails on what breaks only in game
(MICA-312).** That covers CSS past Chromium 103 (`:has()`, container queries,
`dvh`/`svh`, `color-mix()`), a utility class `@mica/sdk` does not define, an
opacity modifier on a themed colour, and `h-full` or bare `flex-1` inside
`Screen`. Each is printed as `file:line rule message`. To use it in an existing
add-on, add `stylelint`, `stylelint-no-unsupported-browser-features` and
`postcss-html` to devDependencies and set `check` as the template does. The
stylelint half is also published as `@mica/sdk/stylelint`. Nothing you compile
against changes.

**See your add-on running without a server: `pnpm dev` in the template
(MICA-311).** It rebuilds on save and serves the bundle on `127.0.0.1:5174`;
open the link it prints and the demo phone loads your add-on in the usual
sandboxed frame, under a strip saying where it came from, with a Reload button.
Your own service answers from `src/mock.ts`, a `defineAddonMock` over your
declaration that runs inside your frame and can simulate pushes. New on
`@mica/sdk/dev`: `defineAddonMock`, `installAddonMock` and the types
`AddonMockDefinition` and `AddonMockTools`. A production build refuses that
import, so the mock can never ship. Additive only: nothing you compile against
changes, and `SDK_CONTRACT_VERSION` does not move. Your browser may ask to allow
the demo to reach your machine, and some browsers refuse it; the template README
says what to expect.

**Your add-on can have a server half in your own resource (MICA-308).** Declare
the service once with `defineAddonService` (exported from `@mica/sdk`, and from
`@mica/shared/addonService` for build-time code that cannot load Svelte), as
plain data with typed fields. Your UI passes the declaration to
`useService(declaration)`, which type-checks every action name, input field and
output. Your resource passes the same declaration to
`exports.mica:RegisterService(declaration, handlers)`; Lua reads it as the JSON
the add-on template's build now emits. Push to your app with
`exports.mica:PushToApp`, and listen with `useAppEvents`. Also new on
`@mica/sdk`: `addonOutput`, `addonError`, and the types
`AddonServiceDeclaration`, `AddonActionName`, `AddonActionInput`,
`AddonActionOutput`, `AddonHandlers` and `AddonErrorAnswer`. `useService('id')`
is unchanged, nothing is required of an existing add-on, and
`SDK_CONTRACT_VERSION` does not move. The README's "Exports for other resources"
has the field kinds, limits and error shape, and `tools/addon-template/` has a
working example of both halves.

**The call state an add-on with the `call` permission reads gains an optional
`line: { number, label }` (MICA-307).** It is set only while a call that came in
through a job line is ringing or connected, and absent otherwise. Nothing was
removed or renamed; `SDK_CONTRACT_VERSION` is unchanged.

**`useAppRegistryWrite()` gains `fetchRemoteCatalog()`, for core apps only
(MICA-237).** It returns the catalog the server fetched on the phone's behalf,
as `ok` with validated entries, `off` when the server has remote add-ons turned
off, or `unavailable`. A sandboxed add-on cannot call it. Nothing was removed:
`fetchCatalog`, `getRemoteCatalogUrl` and `setRemoteCatalogUrl` stay exported,
though the Store no longer uses the first two. `SDK_CONTRACT_VERSION` stays `1`,
and the public catalog a stock server offers is keyed on it:
`https://mica.gg/addons/sdk-1/catalog.json`.

**`useAppVisible(appId)` is new, and needs no permission (MICA-294).** A store
that is `true` only while a device is open, its screen is showing apps, and your
app is the one in front. `onAppForeground` cannot tell you when the phone goes
down, so stop polling on this. In a frame it reads `false` until the shell's
first answer. Also new, with no permission because they touch no host:
`pointerDrag`, a Svelte action that reports drag travel since the press in the
element's own pixels with the pointer captured (options typed
`PointerDragOptions`), and `measureDragRatio(element)`, the Phone Size
correction on its own. Nothing was removed; `SDK_CONTRACT_VERSION` stays `1`.

**`useControlCenter(appId)` is new, behind the new `control-center` permission
(MICA-247).** Put up to three switches of your own in the control center, each
with an `id`, a `label`, an `icon` named from `@mica/sdk`'s icons, a starting
`active` state and an `onToggle`. A tap runs your handler; report the new state
with `setToggleActive`. They show under your app's name, and come down when the
component unmounts or your frame goes away.

**Tones are strings now (MICA-256).** `useSystemHardware` gains
`notificationTone` and `notificationToneChoices`, and `useSystemHardwareWrite`
gains `previewNotificationTone` (under `system-hardware` /
`system-hardware-write`). A ringtone id is any string -- a built-in id or
`owner:<name>` for a server owner's own sound -- so read the choices from
`ringtoneChoices` / `notificationToneChoices` rather than matching names.
`'default'` is always a valid notification tone and is not listed. Setting
either tone stays with built-in apps.

**An add-on can ship a home-screen widget (MICA-245).** Declare
`widget: { sizes: ['2x1'] }` (or `'2x2'`, or both) in the manifest and add
`src/widget.svelte`, which receives `{ size }`; the template passes it to
`bootAddOn` as `{ widget }`. It runs in its own sandboxed frame with your app's
permissions and gets no keyboard or pointer input: a tap on it opens your app.
`widget.load` is for core apps only and is refused on `core: false`. A widget
that never finishes mounting is paused on the next start. Purely additive: a
bundle built before this is unchanged.

**Your frame follows the player's language, and owners can translate it
(MICA-235).** Before this, an add-on's frame changed language only if the add-on
itself called `useLocale()`, so most stayed in English whatever the player
chose; the SDK's frame boot now subscribes for you. An owner's
`locales/<lang>/<your app id>.json` and `locales/<lang>/ui.json` are sent into
your frame and merged over your bundled catalogs — only your own namespace and
`ui`, never another app's. Rebuild against this SDK to get the boot fix; nothing
in your code has to change. The `locale` facet gained a `catalogs` member,
additively, so the contract version does not move.

**`useSearchProvider` is new, and needs no permission (MICA-286).** An app
answers the phone's home search for its own rows:
`useSearchProvider(appId, search)` runs your `search(needle)` and publishes what
it returns as hits under your app's own heading, and the shell opens your app
with the props a hit carries. A `core: false` add-on gets this over the seam
without its rows ever leaving the frame — the shell publishes the query, the
frame answers with the hits it chose — and the app id is stamped by the host, so
a provider can only ever publish under its own name. `ProvidedHit` is exported
beside it. Notes is the first app on it. Additive: the contract version does not
move.

**`useStreamerMode` is new, and needs no permission (MICA-249).** Streamer mode
is a Privacy toggle that blurs every player-supplied picture until it is tapped
and re-blurs it when the view closes, persisted per character through the
settings service. Every image an add-on draws through `MediaThumb` already
honours it. An add-on drawing one some other way reads
`useStreamerMode().streamerMode` for the flag and `revealGeneration`, which
bumps whenever a reveal should be forgotten; `setStreamerMode` is on the hook's
type but the shell refuses it from a `core: false` frame, so only Settings can
flip it. Additive: the contract version does not move.

**`networkHosts` now governs every outbound request from a `core: false` frame,
images, media and fonts included (MICA-202).** The sandbox's `img-src`,
`media-src` and `font-src` were `https: data: blob:`, which let an add-on — or
anything a supply-chain compromise slipped into its bundle — beacon a payload to
any https host with `new Image().src` while `networkHosts` was consulted only
for `fetch()`. They are `data: blob:` plus the declared `networkHosts` now. An
add-on that draws a picture, plays a clip or loads a face from an https host it
has not declared stops rendering it; declare the origin (with
`requiresNetwork: true`) and rebuild. Everything the phone itself hands an
add-on is a `data:` URI and keeps drawing. A tightening rather than a renamed or
removed export, so the contract version does not move.

**Seed theming is on `@mica/sdk/core`, not `@mica/sdk` (MICA-187).**
`DEFAULT_SEED`, `sanitizeSeed`, `seedFromRgbString`, `buildSchemes`,
`cssVarBlock` and `backgroundForScheme` are published for `core: true` apps
only; an add-on keeps reading the phone's scheme through
`useTheme().schemeStore`, and its bundle is unchanged. Additive: the contract
version does not move.

**`useBank()` gained the invoice half (MICA-240)**: `invoices` and
`invoicesLoaded` stores, `fetchInvoices()`, `payInvoice(id)` and
`declineInvoice(id)`, with `Invoice` and `InvoiceActionOutcome` exported as
types. They sit behind the existing `bank` permission, since paying an invoice
moves money exactly as `sendMoney` does. Additive: nothing already published
changes and the contract version is unchanged.

**`useAccount()` gained `historySource` (MICA-241)**, a store of
`{ provider, available }` saying which banking resource `transactions` came from
and whether it can supply history at all; `BankHistory` and `BankHistorySource`
are exported types. Additive: nothing already published changes and the contract
version is unchanged.

**`useJobs()`, behind a new `jobs` permission and a new `jobs` capability
(MICA-228).** The hook answers `jobs` and `jobsLoaded` stores, `fetchJobs()`,
`setActiveJob(name)` and `setDuty(name, onDuty)`; the `JobView`, `JobLine` and
`JobActionOutcome` types are exported from both barrels. `jobs` is its own
permission rather than part of `account` because switching a job changes what
every other resource thinks the player is doing, which is not a read. Declare
`requires: ['jobs']` if your add-on cannot work without one — the capability is
absent on a standalone server, exactly as `money` is. Nothing already published
changes and the contract version is unchanged.

**A manifest may say which devices it runs on (MICA-260).** `devices` is a new
optional field, `['phone']` when absent, so nothing already published changes.
List `'tablet'` and the add-on appears on the 1280x800 tablet frame the shell
can now draw, rendering its one root inside it; `useDisplay()` gained `device`
(`'phone'` or `'tablet'`) and `frame` (the design size) so a root can lay itself
out for either. `ALL_DEVICES` and the `AppDevice` type are exported from
`@mica/sdk`, and a catalog entry carries `devices` the same way. No hook was
added or re-gated and the contract version is unchanged; an add-on that says
nothing is a phone add-on, exactly as before.

Every release now attaches a `SHA256SUMS` file beside the two tarballs, and each
tarball carries a signed build-provenance attestation. `sha256sum -c SHA256SUMS`
checks a download;
`gh attestation verify mica-sdk-<version>.tgz --repo quissicutdeus/mica` proves
GitHub's release job built it from this repository and nothing else did. The
tarballs' contents are unchanged, and both are now checked with `publint` before
they are attached, so a broken `exports` map fails the release rather than your
install.

**The sandbox an add-on runs in is stricter, and four things that used to work
no longer do (MICA-196).** Its Content-Security-Policy now starts from
`default-src 'none'`: a Web Worker does not start (`child-src 'none'`); an
image, media file or font over plain `http:` does not load, while `https:`,
`data:` and `blob:` still do; a frame that reloads or navigates its own document
is torn down rather than greeted again; and a facet member reached by raw
`postMessage` instead of through `@mica/sdk` is refused. Each frame is also
capped at 600 requests per ten seconds, 200 live subscriptions and 128 facet
instances, and the caps refuse rather than tear down. Two optional manifest
fields are new: `services` names the server services the add-on owns (the old
rule that `<id>_anything` was yours remains as a fallback for a manifest without
it), and `sdkContract` names the contract version it was built against, which
the Store checks at install. Rebuild against this SDK, add both fields, and
declare in `networkHosts` any host you fetch from.

**A custom action on a service you declare now needs a contract, and the server
refuses to start without one (MICA-195).** Declare it with `defineContract` from
`@mica/shared/contract` and pass it to `defineService` as `contract`. Objects
are strict, so an undeclared field refuses the request rather than being
dropped; a length cap refuses rather than truncates; a malformed id anywhere in
a batch refuses the whole request. Generic CRUD is unchanged and needs no
declaration. Notes, Blabber and Hodlr in this repo show the shape.

**Your add-on's build now derives its permissions from its imports and fails
when the manifest declares less (MICA-205).** The plugin in
`tools/addon-template/vite.config.ts` reads every module that entered the
bundle, maps each `@mica/sdk` import through the permission table, and stops the
build naming the import and the missing permission. Declaring more stays fine.
Nothing changes at run time: the shell already refused an undeclared call, and
still does; this moves the refusal to where you can read it. Rebuild against the
current template to pick it up; a bundle built without the plugin still
installs.

**`registerMessages` and `useLocale` are new (MICA-61).** An add-on registers
its own catalog under its app id and reads every string through `$t`; nothing on
the phone translates on its behalf. `useLocale().locale` is the active tag,
read-only for an add-on. `formatDate`, `formatTime` and `formatCurrency` now
format under that locale rather than `en-US`, which changes their output for a
player in another language — if you parse what they return, stop. Both names are
additive; the contract stays `v1`.

**An error reply may carry a message key (MICA-216).** `fetchNui` and
`useService(id).call()` still throw an `Error` whose message is what the server
sent; when the reply also carries `key` and the shell's catalog knows it, the
message is the translation instead. Your own server half is unaffected: send
`{ error }` as before and the English shows, or send `{ error, key, params }`
with keys under a namespace you register from your bundle and it translates.
`notifyPlayer` on the server takes `key`, `titleKey` and `params` the same way.

**`useMessages()` gains `hasOlderMessages` and `loadOlderMessages` (MICA-212).**
A thread is read one page at a time now — fifty newest first, older pages
through a cursor — and `messages:get` answers `{ rows, nextCursor }` rather than
a bare array. Both names are additive; nothing an add-on already calls changed
shape except that read, which no add-on reaches through the SDK.

**Consent is checked by the shell, not the Store (MICA-201).** A permission your
manifest declares but the player never granted is refused at call time with the
same `AppPermissionError` an undeclared one gets, and an update that widens
`permissions` is refused until the player accepts the wider set. The
`appRegistryWrite` facet gains `recordConsent` and `grantedPermissions`, both
refused to a sandboxed frame. Additive; the contract stays `v1`.

**`createPagedStore` passes an opaque `PageCursor` through untouched
(MICA-211)**, so a paged service may hand back a compound cursor rather than a
row id. A store built on a bare-id cursor is unaffected. Additive.

**`hostRuntime()` is new beside `isBrowser()` (MICA-177).** It answers
`'browser'`, `'cef'` or `'headless'`, and `isBrowser()` now answers `false`
where there is no `window` instead of throwing. Nothing changes for an add-on
running in a phone; a unit test of one that imports the SDK under Node no longer
dies on the predicate.

**The contract this release publishes is `v1`.** That is `SDK_CONTRACT_VERSION`,
exported from `@mica/sdk`, and it is the number to branch on. It moves when the
SDK's published surface moves and at no other time — the exported names of each
entry point, values and types alike; the props of every exported component; and
the members of every exported string vocabulary such as `ALL_PERMISSIONS`.
`MICA_VERSION` is not that number: it is the running phone's CalVer build stamp,
it moves on every push to `main`, and inside an add-on's own bundle it is
deliberately the empty string. Nothing in the phone consults either one at
install or boot time; this is a number to read and act on, not a compatibility
gate the shell enforces.

**`useSourceUrl` is new**, and needs no permission — it answers one public
string, the address this server says its source lives at, for the AGPL §13
notice in Settings > About > License. An add-on may show the same notice; it is
covered by the same licence with no linking exception, so `LICENSE_COPYRIGHT`,
`LICENSE_FREEDOMS`, `LICENSE_WARRANTY`, `LICENSE_NAME`, `LICENSE_SPDX`,
`LICENSE_SOURCE_OFFER`, `MICA_SOURCE_URL` and `sourceUrlForBuild` are exported
beside it, along with `MICA_BRANCH` (the empty string inside an add-on bundle,
like `MICA_VERSION`). Nothing was removed to make room for any of it.

**No name on that surface was removed or renamed under `v1`**, so an add-on
compiled against it still resolves every import it makes. Two changes recorded
under _Action required_ above do break published add-ons all the same, because
they are shapes a name-level contract cannot express: the eight read hooks that
split from a `-write` half, which moves every setter out of the hook that used
to return it, and `ReactionBar`'s props. Read those two entries if your add-on
repaints the phone, changes a system setting, or draws a reaction row.

**`svelte` and `vite` are now peer dependencies**, where they were development
dependencies before. If you build an add-on outside this repo, your own project
already supplies both — this makes that requirement explicit rather than
accidental. The declared floors are `svelte@^5.46.4` and `vite@^8.0.0`, taken
from what `@sveltejs/vite-plugin-svelte` already enforces to compile this
package's components, not invented here.

What changes for you: an install below either floor now warns, and an install
run with strict peer resolution fails where it previously said nothing. That is
the intended outcome. The failure it replaces is worse and much harder to read —
a consumer resolving its own second copy of Svelte gets two component
registries, and the symptom is components that render once and then quietly stop
reacting. No exported name moved, so `v1` does not move for this; it is a
resolution change at your install, not a contract change.

**The design system is out of contract.** `app.css`, `app-utilities.css` and
`app-reset.css` ship inside the package, and `v1` does not move when they
change. An add-on's CSS is inlined at that add-on's own build, so no bundle can
have compiled against one stylesheet and then been handed another — and a number
that moved for a colour tweak would stop meaning anything for the one case it
exists to serve. The utility classes are still worth reading a diff for; they
are just not a versioned promise.

## 2026-08-27

This file starts here. Tags before this date carry only GitHub's auto-generated
commit lists, which is the record they were released with; they are not
backfilled into prose that nobody wrote at the time.

### Action required

None. No versioned migration exists in `server/migrations/` yet, so no update to
date has required `micaschema apply` for a rename, a retype or a drop.

### Added

- Every convar micaOS reads is now documented in the README's
  [Configuration](README.md#configuration) section, with the defaults as they
  are written in the code — so a server that sets none of them behaves exactly
  as that block shows. Six of them had previously been documented nowhere an
  owner would look. A build check now fails when a convar is added without an
  entry, so the list cannot drift back out of date (MICA-73).

### Notes for anyone installing or updating

- The schema is [`mica.sql`](mica.sql), imported by hand. Every statement is
  `CREATE TABLE IF NOT EXISTS`, so re-importing an existing database is
  harmless.
- micaOS applies no schema change on its own. `micaschema` in the server console
  reports where the database differs from the code and changes nothing;
  `micaschema apply` — console only — applies pending versioned migrations and
  then the safe additive half of the difference.
- When an entry above says a migration landed, run `micaschema apply` from the
  server console after updating the resource and before letting players on.
