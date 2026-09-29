# In-game commands

The console and chat commands micaOS registers, what each one does, and which of
them can change something you cannot get back. `AGENTS.md` §1 carries the
one-line version; this is the reference behind it.

Every command is registered with `RegisterCommand(..., false)` — the `false` is
FiveM's own restriction flag, and it is deliberately not the gate here. micaOS
checks the ace list itself, in the command's handler, so that a refusal can say
something rather than being swallowed by the client.

## Who may run them

**All of them but `micaimport` and `micacrypt` are admin-gated by `isAdmin` in
`server/services/Admin.ts`**; those two take the server console and nobody else.
That reads the `mica_admin_aces` convar, which defaults to `mica.admin` and
`command`:

```cfg
setr mica_admin_aces "mica.admin,mygroup.staff"
```

`command` is in the default list on purpose. `add_ace group.admin command allow`
is the near-universal setup, and anyone holding it can already do anything the
phone's Developer Tools offer by console — so recognising it grants nothing new,
while requiring a second micaOS-specific ace made the resource read as broken to
a server owner who was already a full admin. `mica.admin` stays for granting
phone admin to somebody who is _not_ a server admin, which is the case a
dedicated ace exists for. Ace objects are hierarchical, so allowing `mica`
already covers `mica.admin`.

The convar is read per check, not cached, so adjusting permissions takes effect
without restarting the resource. An empty or whitespace-only value falls back to
the defaults rather than locking everyone out silently.

**The server console (`source` 0) is trusted by definition** — it has no
principals to check.

## The commands

| Command                                 | Does                                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------------- |
| `micaschema`                            | Reports where the database differs from the code. Changes nothing                     |
| `micaschema apply`                      | **Console only.** Runs pending migrations, then the additive pass                     |
| `micamedia`                             | Reports `mica_media`'s size and its top ten holders. Changes nothing                  |
| `micamedia prune`                       | **Console only.** Runs the expiry and orphan sweeps now                               |
| `micacharge [playerId] <0-100>`         | Sets a player's battery level; omit the id for yourself                               |
| `micaseed` / `micaseed add`             | Creates test characters, contacts and threads for the caller                          |
| `micaseed text <firstname> <message>`   | Has a seeded character text you — exercises inbound delivery                          |
| `micaseed clear`                        | Removes everything `micaseed` created                                                 |
| `micacall [number \| firstname]`        | Rings yourself — a real call, peer faked. See `docs/testing-voip.md`                  |
| `micacall end`                          | Force-ends your own active call                                                       |
| `micaimport <qb-phone\|lb-phone\|npwd>` | **Console only.** Reports what it would bring across from that phone. Changes nothing |
| `micaimport <source> --apply`           | **Console only.** Brings it across. A second run brings nothing new                   |
| `micacrypt status`                      | **Console only.** Counts sealed, plaintext and unreadable bodies. Changes nothing     |
| `micacrypt backfill`                    | **Console only.** Reports what `--apply` would seal. Changes nothing                  |
| `micacrypt backfill --apply`            | **Console only.** Seals plaintext bodies and re-seals old keys'. Safe to repeat       |
| `micacrypt keygen <absolute path>`      | **Console only.** Writes a new key file, mode 600. Never overwrites one               |

Source: `server/services/Schema.ts`, `Media.ts`, `Battery.ts`, `Seed.ts`,
`Phone.ts`, `Import.ts` and `ContentKeys.ts` respectively — one
`RegisterCommand` each.

## The two that are gated harder than the rest

**`micaschema apply` and `micamedia prune` take the server console and nobody
else**, `isAdmin` notwithstanding. They are the only two commands in the
resource that destroy or restructure data a server owner cannot get back: one
changes a live schema, the other deletes rows. Both check `isAdmin` _first_, so
an ordinary player is refused for the same reason they would be refused the
report, rather than being told a privileged subcommand exists.

Each one has a dry run, and it is the bare command. `micaschema` reports the
drift the migrator will and will not touch; `micamedia` reports the table's size
and its heaviest holders. **Read the bare form before running either
subcommand** — `micamedia` in particular is what an owner should read before
setting `mica_media_retention`, since a retention window nobody measured against
the real table is how a sweep removes more than anyone expected. If
`mica_media_retention` is unset, `prune` says so and still runs the orphan
sweep.

## `micaimport` takes the console for its dry run too

`micaimport` (MICA-233) reads another phone's tables — qb-phone's, lb-phone's or
NPWD's, in the same database — and brings contacts, threads, gallery images and
posts across. Unlike the two above, even the bare form is console-only: its
report names every table and counts every player's rows, which is more of the
database than an in-game admin needs to see, and there is no in-game reason to
run it. Anyone else is refused with the same message as `micaschema apply`.

The bare command is the dry run and writes nothing, not even a phone for a
player who has none yet. `--apply` writes, and records each source row it
brought across in `mica_import_ledger`, so a second `--apply` reports zero new
rows and an interrupted run can simply be repeated. The source tables are only
read. Every row it does not bring across is counted under a reason — an owner it
cannot match to a character, an attachment, a post over 280 characters, a
duplicate — so the report adds up to what the source held. A text message longer
than 12,276 characters is cut to that length, never through the middle of an
emoji, and with a content key set every imported message is sealed on the way
in. Source: `server/lib/import/`.

## `micacrypt` is console only, all of it

`micacrypt` (MICA-165) manages the key that seals message, DM and mail bodies at
rest; [`docs/security.md`](security.md) has what that does and does not protect.
Every subcommand refuses any `source` but the console, `status` included: its
counts describe every player's content, and `backfill --apply` rewrites it. Only
one `status` or `backfill` runs at a time.

- **`keygen <absolute path> [kid]`** writes a keyring file holding one new key,
  mode 600, and prints the `set mica_content_key_file "<path>"` line for
  `server.cfg`. The key id defaults to `k`, the UTC date and the time
  (`k20260929-1824`), and an id the running keyring already holds is refused,
  since a key file with one id twice is refused whole. It refuses a relative
  path and an existing file, since a key overwritten is every body sealed with
  it gone, and it repeats the boot warning when the path is inside the resource
  or `server-data`. Use `set`, never `setr`, which would send the path to every
  client.
- **`status`** counts, per sealed column, the rows under the active key, under
  each older key, still plaintext, sealed but unreadable, and plaintext too long
  to seal, plus persisted DM notifications that still carry message text.
- **`backfill`** is the dry run of the same walk. **`backfill --apply`** seals
  every plaintext body, re-seals every body under an older key, and blanks the
  old DM notifications. It walks each table by id, `--batch N` rows at a time
  (default 500, at most 5000), one compare-and-set `UPDATE` per row, so no
  statement locks or rewrites a table, and a body a player edits mid-run is left
  for the next run rather than overwritten. `updated_at` is pinned, so nothing
  reads as edited. A second run changes nothing. It refuses to start without a
  usable key.

**Rotating the key** is the same command. Run `keygen` to a scratch path, put
its key line **first** in the live key file with the old lines after it, restart
the resource, run `backfill --apply`, and remove an old line only once `status`
shows nothing left under it. A body under a key that is no longer in the file
reads as 🔒.

## `micacall` runs in game, not from the console

It refuses `source` 0 with "Run this in game as the player you want to ring."
The command rings _you_, so there has to be a you. With no argument it uses
`5550100`; with a seeded character's first name it rings from that character's
number, mirroring `micaseed text <firstname>`.
[`docs/testing-voip.md`](testing-voip.md) maps how far this gets you without a
second connected player, and where it honestly stops.

## Why `micaseed` writes real `players` rows

A fresh database has one character and nobody to text, and a conversation needs
a real counterpart: `conversations:create` resolves a phone number to a
`citizenid` and gives up when it cannot, and
`mica_messages_participants.citizenid` is a foreign key onto `players`. A
made-up string will not do.

So the seeded rows are genuine `players` rows. They are marked twice — by a
license nothing else in the database uses (`SEED_LICENSE`, `server/lib/seed.ts`)
and by a `citizenid` prefix — which is what lets `micaseed clear` remove exactly
its own rows and nothing a person made. Nothing seeds automatically; the command
is the only way in.

`micaseed clear` needs no loaded character, because it is scoped by the license
rather than by the caller. Every other form does: run it in game, as the
character you want the data to belong to.
