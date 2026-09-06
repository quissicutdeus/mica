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
a fresh install.** It carries `id`, `citizenid`, `number`, `status`,
`created_at` and `updated_at`, with a `status` key, a `citizenid_status` key,
and two unique keys, `number_unique` and `citizenid_unique`. It is how micaOS
issues a phone number on a server running with no framework, where there is no
framework to issue one — a number is generated at random on a player's first
connection and stays with them across reconnects. **On qb and ESX the table is
created and stays empty**, and the framework's own number is used exactly as
before; nothing about an existing server's numbering changes. It is created on
every framework rather than only on standalone because `mica.sql` and
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

Every convar below defaults to the behaviour a server already had, so an update
that sets none of them changes nothing for your players.

### Added

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

### Fixed

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

### For add-on authors

Everything above is written for a server owner. This part is not. It is for
somebody maintaining a `core: false` add-on outside this repo, and it answers
one question: does that bundle still compile against this release, and does its
manifest still ask for the right things.

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
