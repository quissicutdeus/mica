# In-game commands

The console and chat commands gOS registers, what each one does, and which of
them can change something you cannot get back. `AGENTS.md` §1 carries the
one-line version; this is the reference behind it.

Every command is registered with `RegisterCommand(..., false)` — the `false` is
FiveM's own restriction flag, and it is deliberately not the gate here. gOS
checks the ace list itself, in the command's handler, so that a refusal can say
something rather than being swallowed by the client.

## Who may run them

**All of them are admin-gated by `isAdmin` in `server/services/Admin.ts`.** That
reads the `gos_admin_aces` convar, which defaults to `gos.admin` and `command`:

```cfg
setr gos_admin_aces "gos.admin,mygroup.staff"
```

`command` is in the default list on purpose. `add_ace group.admin command allow`
is the near-universal setup, and anyone holding it can already do anything the
phone's Developer Tools offer by console — so recognising it grants nothing new,
while requiring a second gOS-specific ace made the resource read as broken to a
server owner who was already a full admin. `gos.admin` stays for granting phone
admin to somebody who is _not_ a server admin, which is the case a dedicated ace
exists for. Ace objects are hierarchical, so allowing `gos` already covers
`gos.admin`.

The convar is read per check, not cached, so adjusting permissions takes effect
without restarting the resource. An empty or whitespace-only value falls back to
the defaults rather than locking everyone out silently.

**The server console (`source` 0) is trusted by definition** — it has no
principals to check.

## The commands

| Command                              | Does                                                                 |
| ------------------------------------ | -------------------------------------------------------------------- |
| `gosschema`                          | Reports where the database differs from the code. Changes nothing    |
| `gosschema apply`                    | **Console only.** Runs pending migrations, then the additive pass    |
| `gosmedia`                           | Reports `gos_media`'s size and its top ten holders. Changes nothing  |
| `gosmedia prune`                     | **Console only.** Runs the expiry and orphan sweeps now              |
| `goscharge [playerId] <0-100>`       | Sets a player's battery level; omit the id for yourself              |
| `gosseed` / `gosseed add`            | Creates test characters, contacts and threads for the caller         |
| `gosseed text <firstname> <message>` | Has a seeded character text you — exercises inbound delivery         |
| `gosseed clear`                      | Removes everything `gosseed` created                                 |
| `goscall [number \| firstname]`      | Rings yourself — a real call, peer faked. See `docs/testing-voip.md` |
| `goscall end`                        | Force-ends your own active call                                      |

Source: `server/services/Schema.ts`, `Media.ts`, `Battery.ts`, `Seed.ts` and
`Phone.ts` respectively — one `RegisterCommand` each.

## The two that are gated harder than the rest

**`gosschema apply` and `gosmedia prune` take the server console and nobody
else**, `isAdmin` notwithstanding. They are the only two commands in the
resource that destroy or restructure data a server owner cannot get back: one
changes a live schema, the other deletes rows. Both check `isAdmin` _first_, so
an ordinary player is refused for the same reason they would be refused the
report, rather than being told a privileged subcommand exists.

Each one has a dry run, and it is the bare command. `gosschema` reports the
drift the migrator will and will not touch; `gosmedia` reports the table's size
and its heaviest holders. **Read the bare form before running either
subcommand** — `gosmedia` in particular is what an owner should read before
setting `gos_media_retention`, since a retention window nobody measured against
the real table is how a sweep removes more than anyone expected. If
`gos_media_retention` is unset, `prune` says so and still runs the orphan sweep.

## `goscall` runs in game, not from the console

It refuses `source` 0 with "Run this in game as the player you want to ring."
The command rings _you_, so there has to be a you. With no argument it uses
`5550100`; with a seeded character's first name it rings from that character's
number, mirroring `gosseed text <firstname>`.
[`docs/testing-voip.md`](testing-voip.md) maps how far this gets you without a
second connected player, and where it honestly stops.

## Why `gosseed` writes real `players` rows

A fresh database has one character and nobody to text, and a conversation needs
a real counterpart: `conversations:create` resolves a phone number to a
`citizenid` and gives up when it cannot, and
`gos_messages_participants.citizenid` is a foreign key onto `players`. A made-up
string will not do.

So the seeded rows are genuine `players` rows. They are marked twice — by a
license nothing else in the database uses (`SEED_LICENSE`, `server/lib/seed.ts`)
and by a `citizenid` prefix — which is what lets `gosseed clear` remove exactly
its own rows and nothing a person made. Nothing seeds automatically; the command
is the only way in.

`gosseed clear` needs no loaded character, because it is scoped by the license
rather than by the caller. Every other form does: run it in game, as the
character you want the data to belong to.
