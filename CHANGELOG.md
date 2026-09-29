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
owner's phone, minting an unclaimed phone for any character who had a charge and
nothing else, and replaces `citizenid_unique` with `phone_id_unique`: two phones
hold two charges, and a battery bank charges the one in hand. Switching phones
saves the old phone's charge and loads the new one's. `LockPhone`, `UnlockPhone`
and `IsPhoneLocked` are keyed on the phone in the player's hand rather than on
the player, so a burner picked up locked stays locked and unlocking one phone
unlocks nothing else; a lock applied before a player has resolved a phone stays
on the player, as before. Using a different phone item now rehydrates the shell,
so the screen shows that phone's contacts, threads, settings and passcode status
rather than the previous phone's until the next open. `GetBatteryLevel` answers
for the phone the character is on. Nothing here changes on a server without the
phone-item gate, where every character still has exactly one phone.

**A phone's data now belongs to the phone: contacts, notes, media, the lock
screen, settings, notifications, the call log, saved places, the block list and
a thread's membership all follow the item — run `micaschema apply` from your
server console after updating, before players connect (MICA-282).** This is the
change the whole phone-as-item work was for: steal a phone and its contacts,
messages and photos come with it; carry two and each has its own. It reaches
every server, gated or not, because it changes the shape of ten tables, and it
is the one migration in this series an owner cannot skip.

`mica_contacts`, `mica_notes`, `mica_media`, `mica_lockscreen`, `mica_settings`,
`mica_notifications`, `mica_phone_call_log`, `mica_places`, `mica_blocklist` and
`mica_messages_participants` each gain a `phone_id` column and a `phone_id` key.
`mica_phones` gains a `claimed` column. The migration
`0002_phone_data_follows_the_phone` then puts every existing row on its owner's
phone — a character who already has a phone keeps it, and one who does not gets
one minted for them, which the first phone item they use picks up — attaches
each character's number to it, rewrites a 1:1 thread's `participant_a` and
`participant_b` from the two characters to their two phones, and replaces four
per-character unique keys with per-phone ones: `mica_lockscreen` loses
`citizenid_unique` for `phone_id_unique`, `mica_settings` loses
`citizenid_app_key` for `phone_app_key`, `mica_blocklist` loses
`citizenid_number_unique` for `phone_number_unique`, and
`mica_messages_participants` loses `conversation_participant_unique` for
`conversation_phone_unique`. No row is deleted and nothing is rewritten but
those columns and keys. `citizenid` stays on every table: it now names whoever
holds the phone, and moves with the phone when it changes hands.

**What a player sees.** On a server that gates the phone on an item, a phone
shows its own contacts, threads, photos and settings and nothing from the
player's other phones; a player holding no phone is told so rather than shown
somebody else's data. A stolen phone continues its own threads and keeps its own
passcode until the thief clears it. On a server without the gate — every ESX
server, standalone, and any qb server that never set `mica_phone_item` — nothing
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
`0001_phone_numbers_follow_the_phone` drops `citizenid_unique`, because a
character holding two phones holds two numbers.

**Nobody's number changes on upgrade.** On qb and qbx the migration copies every
existing character's `charinfo.phone` into `mica_phone_numbers` as that
character's number, and the first time they use a phone the number moves onto
it. A character created after the update keeps the number qb issued too: micaOS
adopts it the first time they connect rather than generating one. The one
exception is two characters sharing a `charinfo.phone`, which qb does not
prevent — the second to connect is issued a fresh number, and the migration
prints how many characters that affects. Apply the migration before players
connect; a server that skips it has micaOS issue and write back fresh numbers as
players load, which is the behaviour the migration exists to avoid.

**The framework is kept in step.** Whenever the active phone changes, its number
is written into `charinfo.phone` through the framework's own export — qbx_core's
`SetCharInfo`, or a qb-core player's `SetPlayerData` — so `GetPlayerByPhone`,
your dispatch and job scripts, and anything else reading `charinfo.phone` keep
working unmodified. A player left holding no phone keeps the last value the
framework had rather than a blank, which would break those scripts; a stolen
phone rings for whoever is holding it, and micaOS's own lookups resolve through
the phone rather than through the stale field.

**On es_extended nothing changes.** There is no standard way to set an ESX
character's phone number, so micaOS keeps reading whatever your phone-number
resource provides, issues none of its own, and says so once at start. A phone
that changes hands there keeps the holder's own number. Standalone is unchanged
apart from the new column: it was already micaOS's number, and a standalone
server has no inventory to hold two phones in.

This needs the phone-as-item gate (`mica_phone_item`) and `ox_inventory` to mean
anything per phone; without them every server, qb included, behaves as one
number per character, exactly as before, with the number now recorded in
`mica_phone_numbers` as well as `charinfo`.

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
into `pair_key`, which a unique index constrains — closing the race where two
people opening a chat at the same moment could end up with two threads for the
same pair. The migration backfills the new columns for existing one-to-one
threads and adds the index; if your server already has more than one active
thread for the same pair (a residue of that race before this fix), the index is
added as a plain, non-unique key instead — nothing is merged or deleted, and no
message history is touched.

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
a unique `phone_id_unique` key. It is the first step of the phone becoming a
thing you carry rather than something a character simply has: a phone gets an
identity of its own, minted into the inventory item's metadata the first time it
is used, so two phones are two phones. The phone number is the first thing to
follow it (MICA-284, above); contacts, messages and the rest of a phone's data
come in a later release.

`phone_id` is unique; `citizenid` deliberately is not, because a character is
meant to be able to hold more than one phone. **This needs `ox_inventory`**: it
is the only inventory with per-item metadata to mint an id into. On qb-inventory
support depends on whether your build exposes `SetItemData`, and es_extended's
own inventory stores quantities only and cannot carry a phone id at all — those
servers keep exactly the behaviour they have now, and say so once at start.

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

### Added

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
new convars: `mica_tablet` (default `false`) turns the tablet on, and
`mica_tablet_item` gates it on an inventory item independently of
`mica_phone_item`. **Leave `mica_tablet` off unless you are testing:** the
tablet has no identity of its own until MICA-264, so what it stores may move
when that lands. `IsPhoneOpen`, `SetPhoneEnabled`, `LockPhone`, `UnlockPhone`,
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
(MICA-231):** how a shop sells a blank phone and what happens on first use, what
a robbery or a trade moves and what it leaves with the character, how a
confiscation script takes a phone and gives it back with its data intact, what
becomes of the rows when an item is destroyed, and what a burner does and does
not hide. Read it before wiring any of those scripts to the item; the one rule
it keeps returning to is that a script which removes the item and adds a fresh
one has made a different phone.

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
setting, add-ons included. A character load, or switching to a different phone
item, now removes whatever the new character's saved settings do not include. A
setting changed in the last moment before a reload is kept, and so is anything
an app deliberately stores per device. No owner action.

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
