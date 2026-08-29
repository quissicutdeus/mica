# In-game commands

The console and chat commands gPhone registers, what each one does, and which of
them can change something you cannot get back. `AGENTS.md` §1 carries the
one-line version; this is the reference behind it.

Every command is registered with `RegisterCommand(..., false)` — the `false` is
FiveM's own restriction flag, and it is deliberately not the gate here. gPhone
checks the ace list itself, in the command's handler, so that a refusal can say
something rather than being swallowed by the client.

## Who may run them

**All of them are admin-gated by `isAdmin` in `server/services/Admin.ts`.** That
reads the `gphone_admin_aces` convar, which defaults to `gphone.admin` and
`command`:

```cfg
setr gphone_admin_aces "gphone.admin,mygroup.staff"
```

`command` is in the default list on purpose. `add_ace group.admin command allow`
is the near-universal setup, and anyone holding it can already do anything the
phone's Developer Tools offer by console — so recognising it grants nothing new,
while requiring a second gPhone-specific ace made the resource read as broken to
a server owner who was already a full admin. `gphone.admin` stays for granting
phone admin to somebody who is _not_ a server admin, which is the case a
dedicated ace exists for. Ace objects are hierarchical, so allowing `gphone`
already covers `gphone.admin`.

The convar is read per check, not cached, so adjusting permissions takes effect
without restarting the resource. An empty or whitespace-only value falls back to
the defaults rather than locking everyone out silently.

**The server console (`source` 0) is trusted by definition** — it has no
principals to check.

## The commands

| Command                                 | Does                                                                   |
| --------------------------------------- | ---------------------------------------------------------------------- |
| `gphoneschema`                          | Reports where the database differs from the code. Changes nothing      |
| `gphoneschema apply`                    | **Console only.** Runs pending migrations, then the additive pass      |
| `gphonemedia`                           | Reports `gphone_media`'s size and its top ten holders. Changes nothing |
| `gphonemedia prune`                     | **Console only.** Runs the expiry and orphan sweeps now                |
| `gphonecharge [playerId] <0-100>`       | Sets a player's battery level; omit the id for yourself                |
| `gphoneseed` / `gphoneseed add`         | Creates test characters, contacts and threads for the caller           |
| `gphoneseed text <firstname> <message>` | Has a seeded character text you — exercises inbound delivery           |
| `gphoneseed clear`                      | Removes everything `gphoneseed` created                                |
| `gphonecall [number \| firstname]`      | Rings yourself — a real call, peer faked. See `docs/testing-voip.md`   |
| `gphonecall end`                        | Force-ends your own active call                                        |

Source: `server/services/Schema.ts`, `Media.ts`, `Battery.ts`, `Seed.ts` and
`Phone.ts` respectively — one `RegisterCommand` each.

## The two that are gated harder than the rest

**`gphoneschema apply` and `gphonemedia prune` take the server console and
nobody else**, `isAdmin` notwithstanding. They are the only two commands in the
resource that destroy or restructure data a server owner cannot get back: one
changes a live schema, the other deletes rows. Both check `isAdmin` _first_, so
an ordinary player is refused for the same reason they would be refused the
report, rather than being told a privileged subcommand exists.

Each one has a dry run, and it is the bare command. `gphoneschema` reports the
drift the migrator will and will not touch; `gphonemedia` reports the table's
size and its heaviest holders. **Read the bare form before running either
subcommand** — `gphonemedia` in particular is what an owner should read before
setting `gphone_media_retention`, since a retention window nobody measured
against the real table is how a sweep removes more than anyone expected. If
`gphone_media_retention` is unset, `prune` says so and still runs the orphan
sweep.

## `gphonecall` runs in game, not from the console

It refuses `source` 0 with "Run this in game as the player you want to ring."
The command rings _you_, so there has to be a you. With no argument it uses
`5550100`; with a seeded character's first name it rings from that character's
number, mirroring `gphoneseed text <firstname>`.
[`docs/testing-voip.md`](testing-voip.md) maps how far this gets you without a
second connected player, and where it honestly stops.

## Why `gphoneseed` writes real `players` rows

A fresh database has one character and nobody to text, and a conversation needs
a real counterpart: `conversations:create` resolves a phone number to a
`citizenid` and gives up when it cannot, and
`gphone_messages_participants.citizenid` is a foreign key onto `players`. A
made-up string will not do.

So the seeded rows are genuine `players` rows. They are marked twice — by a
license nothing else in the database uses (`SEED_LICENSE`, `server/lib/seed.ts`)
and by a `citizenid` prefix — which is what lets `gphoneseed clear` remove
exactly its own rows and nothing a person made. Nothing seeds automatically; the
command is the only way in.

`gphoneseed clear` needs no loaded character, because it is scoped by the
license rather than by the caller. Every other form does: run it in game, as the
character you want the data to belong to.
