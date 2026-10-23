# The phone as an item: shops, robbery, confiscation and burners

micaOS does not ship a phone shop, a robbery script or a police confiscation
flow. Those belong to the server's own economy and job scripts, which already
decide who can buy what, what a robbery costs and what an officer may take. What
micaOS ships is the item model underneath them (MICA-219): a phone is an
inventory item with an id of its own, and the number, the data and the lock
belong to that id, which belongs for good to the citizen who first used it
(MICA-436), rather than to whichever character holds the item. This page shows
what each of those scripts looks like on top of it, written from the code that
implements it, so an owner asking "how do I sell phones" on day one has an
answer rather than a missing feature.

Everything here assumes `mica_phone_item` is set. With it empty, which is the
default, the phone is not an item and none of this applies: every character has
exactly one phone, always in hand, and its rows are keyed on an _identity phone_
micaOS mints for them without ever writing into an inventory. The README's "The
phone as an item" section covers the gate itself; this page picks up where it
stops.

## The item, and where the id lives

The item is whatever `mica_phone_item` names, defined in your inventory's own
terms. The definitions per inventory are in the README; the short version is
that qb-core and ox_inventory both ship an item called `phone` already, so
`set mica_phone_item "phone"` needs nothing else on those.

The phone's id is minted the first time a player **uses** the item, and it is
written into that slot's metadata under the key `deviceId`
(`server/services/Devices.ts`, `resolvePhone`). Where that key lands depends on
the inventory (`server/lib/framework/itemMetadata.ts`):

| Inventory                                       | Where `deviceId` is stored                                                            | Read | Write                                    |
| ----------------------------------------------- | ------------------------------------------------------------------------------------- | ---- | ---------------------------------------- |
| ox_inventory (qbx_core, or ox on qb-core / ESX) | the slot's `metadata` table, through `SetMetadata`, merged with what is already there | yes  | yes                                      |
| qb-inventory                                    | the item's `info` table                                                               | yes  | only if your build exposes `SetItemData` |
| es_extended's own inventory                     | nowhere: it stores quantities only                                                    | no   | no                                       |

The id is a 32-character hex string and nothing about it is a secret. A copied
id grants nothing on its own, because every read and write still names the
character presenting it as well (`docs/security.md`, and the ownership rule
below). The one thing to protect is the metadata itself: **a script that moves a
phone by removing the item and adding a fresh one has made a different phone.**
ox_inventory keeps metadata when a player drags an item between inventories,
stashes it or drops it, and `exports.ox_inventory:AddItem` takes a `metadata`
argument you can pass the old slot's table to. A bare `AddItem` with no metadata
hands the player a blank phone that mints a new id on first use, with a new
number and none of the old data. Robbery and confiscation scripts are the two
places this bites, and both sections below say where.

On es_extended's own inventory none of this applies. There is no metadata to
mint into, so the server says so once at start, every character keeps the one
identity phone they always had, and a shop selling the item sells a key to open
it and nothing more.

## Selling a blank phone

A shop sells the item; micaOS does the rest on first use. Nothing needs to be
created ahead of time, and no export needs to be called.

ox_inventory shops are declared in its `data/shops.lua`:

```lua
-- ox_inventory: data/shops.lua
General = {
    name = 'Shop',
    inventory = {
        { name = 'phone', price = 250 },
        -- ...
    },
    locations = { vec3(25.7, -1347.3, 29.49) },
},
```

qb-shops lists products per shop in its `config.lua`:

```lua
-- qb-shops: config.lua, inside a shop's products
{ name = 'phone', price = 250, amount = 50 },
```

What happens on first use (`resolvePhone` in `server/services/Devices.ts`, and
`numberForPhone` in `server/services/PhoneNumbers.ts`), in order:

1. The item carries no `deviceId`. If the character has an **unclaimed identity
   phone** (`mica_devices.claimed = 0`), the item adopts it: that is the phone
   the upgrade migration put all their existing rows on, and it is why a
   player's contacts survive the day you turn the gate on. Otherwise a fresh id
   is minted.
2. The id is written into the item's metadata. If the inventory cannot store it,
   the phone is left unavailable rather than given an id the item does not
   carry, and the server has already said why once.
3. A number is settled. A number already on this phone stays. Failing that, the
   character's **legacy number** (the one they had before numbers followed
   phones, copied in from `charinfo.phone` by migration) is attached to this
   phone. Failing that, a fresh number is assigned, preferring whatever the
   framework already had for them.
4. The framework is told: on qbx_core through `SetCharInfo`, on qb-core through
   `SetPlayerData`, so `GetPlayerByPhone` and dispatch see the new number. On
   ESX numbers stay the character's, because there is no standard setter.

So a character's **first** phone is a continuation of who they were, number
included. Their **second** phone, bought while the first still exists, gets a
fresh id and a fresh number, and that is the burner recipe at the end of this
page.

A shop that wants to sell a phone with a number chosen at the counter has no
export for that today. `RegisterNumber` is for a resource claiming a callable
number of its own, not for assigning one to a player.

## Robbery and trade

There is nothing to script for the data, because **nothing moves**. A phone
belongs to the citizen who first used it, for good (MICA-436): that citizen is
the `citizenid` on its `mica_devices` row and on every device-owned row on it,
and nothing hands it to anybody else. The item travels between inventories with
its id intact; the ownership does not travel with it. So when somebody else ends
up holding a phone that has been used:

- **They get a closed phone.** The item gate counts a slot only when it is the
  player's own, theirs to claim, or blank, by the same rule the server resolves
  a request by (`judgeRow` in `server/services/Devices.ts`, installed into the
  gate through `installSlotJudge` in `server/lib/deviceItem.ts`). A player
  holding nothing but other people's phones is told they hold none, and using
  the item from the inventory opens nothing. A player holding a phone of their
  own as well keeps it: the other is skipped as though it were not there. (On
  qb-inventory, which lists one slot, which of the two is judged depends on the
  slot the inventory reports, so the player can be refused their own.)
- **A request that arrives anyway is refused.** A client that opens the phone
  regardless is answered with the refusal a player holding no phone gets,
  `server.phone.notHeld` ("You are not holding a phone."). Nothing is written
  for a phone that is skipped: no row is claimed, created or moved.
- **The owner's rows stay where they were.** Contacts, notes, photos, places,
  settings, the passcode row, notifications, the call log, the block list,
  thread memberships and the battery charge are all still keyed on the phone and
  on the owner. A text addressed to the phone's number is still filed on that
  phone, and so is the call-log row for a call to it (`readPhoneIdByNumber`),
  and so are notifications and dropped photos for the owner while it is the
  phone they last used (`phoneForCitizen`). They wait there. Nobody can read
  them but the owner, and the owner can only if the phone comes back.
- **The number stays with the owner.** `numberForPhone` is reached only for a
  phone that resolved to its owner, so the thief's `charinfo.phone` is never
  rewritten to the stolen number, and `mica_phone_numbers` keeps naming the
  owner.
- **The passcode never comes into it.** The lock screen is a display state the
  client enforces, not a server boundary (`server/lib/LockState.ts` says so
  plainly), and that is the reason ownership is checked on the server instead of
  being left to it.
- What was never on the phone: the owner's Bank, Hodlr holdings, Marketplace
  listings, Blabber account, mail and high scores. Those are keyed on the
  character, so a thief has nothing to reach even before the refusal.
  `docs/schema-and-services.md` has the table-by-table split.

The victim, holding no phone, sees a closed phone: the client relays the
inventory change (`client/services/DeviceItem.ts` listens for
`ox_inventory:itemCount`, `QBCore:Player:SetPlayerData`, `esx:addInventoryItem`
and `esx:removeInventoryItem`) and the server counts again and pushes the
answer. Buying a new phone gives them a fresh id and a fresh number; their old
contacts are on the phone that was taken, and a thief cannot read them either.
That is the model working as designed, and a server that finds it too harsh
should make robbery scripts return the item rather than soften the model.

**Why nothing moves.** Before MICA-436 the next player to use a phone became its
holder and every row on it was rewritten to them. That decision handed a phone's
whole contents to whoever could get the item into their inventory, on the
strength of item metadata that any resource can write, behind a passcode only
the client checks. Item duplication is among the commonest exploits on a FiveM
server, and under that rule whoever held a duplicated phone could read all of
its owner's. The handover was removed rather than switched off, because it had
never run in a live server (MICA-230 was never proven) and there was no proven
behaviour worth keeping behind a switch.

**Selling a phone, and what it costs.** A phone nobody has used has no owner
yet, so a shop's stock is unaffected: the buyer is its first user. A phone
somebody has **used** cannot be sold on, given or traded to a second player:
they hold it, and it reads closed for them. Until the owner can reset a phone
for the next person, which does not exist yet and is a follow-up rather than
part of this change (MICA-437), a player who wants to pass a phone on cannot.
Plan any second-hand phone trade around that.

A robbery script therefore has one thing to decide, and it is not about data.
Moving the item with its metadata (in ox_inventory, `RemoveItem` followed by
`AddItem(target, 'phone', 1, metadata)` with the slot's original `metadata`
table) moves a phone that is closed to its new holder. To give the robber a
phone that works, give them a blank one, which mints an id of its own the first
time they use it.

## Confiscation and return

Two independent controls exist, and a confiscation script normally wants both:

**Take the item.** Remove the phone from the player's inventory and put it in
the officer's, or in an evidence stash. The player's phone closes as soon as the
client relays the change, exactly as it does on a robbery. The data goes
nowhere: the rows keep their `device_id`, with `citizenid` still naming the
player. An officer who uses the confiscated phone is refused it as a thief is
(see "Robbery and trade"): it reads closed in their hand and there is nothing
for them to read. Before MICA-436 the officer became its holder and could read
everything on it; if your evidence scripts relied on that, they cannot any more,
and micaOS does not ship a way for one player to read another's phone, so a
server that wants one has to build it as its own thing.

**Disable the phone.** `exports['mica']:SetPhoneEnabled(source, false)` forces
the phone closed and keeps it closed whatever the inventory says, and `true`
returns it (`server/lib/publicApi.ts`). This is the tool for a jail or a "phone
privileges revoked" state where the item stays in the pocket. The two are
independent by design: a phone a job has confiscated stays confiscated whatever
the inventory says, and the other way round.

`SetPhoneEnabled` is **not persisted**. It is a push to the client, and a player
who reconnects comes back enabled, the same as `LockPhone`. A script that needs
the state to survive a relog or a restart reapplies it from its own record on
the framework's player-loaded event, which is how every other resource on the
server already treats `SetPhoneEnabled`-shaped state.

**Returning the phone** is moving the item back with its metadata intact, then
`SetPhoneEnabled(source, true)` if it was disabled. The player uses it and finds
everything where they left it: same id, same number, same data. Return needs
nothing else, because nothing was handed over to be handed back, whether or not
an officer tried the phone in between. The failure to avoid is the one from the
first section: an evidence script that stores "1 × phone" as a count and gives
back a fresh item has destroyed the phone and handed the player a blank one.

## Destroyed, dropped on death or traded

micaOS reacts to an item **leaving a player's hand** (the phone closes) and to
an item **being used** (it opens only for its own citizen). It does not react to
an item ceasing to exist. There is no inventory event for "this item was
destroyed" that every framework agrees on, and a phone in a stash, on the
ground, or in a dead player's dropped inventory looks identical to one that is
gone forever.

So when a phone item is destroyed, its rows stay exactly where they are: keyed
on a `device_id` no item carries any more, with `citizenid` naming its owner,
and a `mica_devices` row that is now permanently claimed. Nothing reads them
again, and nothing deletes them. The same is true of a phone dropped on death
and never picked up. A trade is not this case at all: the phone still exists and
the buyer holds it, but it was never theirs. It reads closed for them and the
seller's rows are untouched, so a phone somebody has used cannot be traded on
(see "Robbery and trade" for what that costs, and for a blank phone, which has
no owner yet).

What already covers some of that:

- **The orphan sweep** (`server/lib/orphanSweep.ts`) hides the rows of a
  _character_ that no longer exists (`erased`, MICA-428: nothing is deleted). It
  runs at resource start and when another server resource triggers
  `mica:server:shell:characterDeleted` with a citizenid. On qb it is a backstop
  for the schema's old `ON DELETE CASCADE`; on ESX it is the cleanup. It leaves
  the device rows live, because the phone item can outlive its character and an
  erased `mica_devices` row would make the next holder's resolve try to create
  it again, which `device_id_unique` refuses. Left live, the row still names the
  deleted character, so that phone reads closed for everyone who holds it from
  then on, like any phone that is not theirs (MICA-436). It does nothing for a
  destroyed phone whose owner still plays.
- **Notification retention** (`mica_notification_retention`, 30 days) hides old
  notifications on every phone, destroyed or not.
- **Media retention** (`mica_media_retention`, off by default) expires media
  older than the window, keeping the row, and `micamedia prune` from the console
  runs that and the media orphan sweep now (`docs/in-game-commands.md`).
- **`mica_restore_window_days`** (30) is how long a soft-deleted contact, note
  or photo stays restorable. It deletes nothing past the window, on purpose:
  moderation depends on a soft-deleted row surviving.

There is no export or command today that says "this phone id is gone, drop its
rows". On a server where phones are destroyed often, the abandoned rows are
small and inert, and they are never reclaimed: nothing deletes a row. An owner
who needs that has to delete `WHERE device_id = ?` by hand across the
device-owned tables, in the order `docs/schema-and-services.md` lists them.

## A burner

Buy a second phone and use it. That is the whole recipe:

1. Using the second item mints a fresh id (the identity phone was already
   adopted by the first), so it is a new phone with none of the first one's
   data.
2. Its number is a fresh assignment: no number is on the item, and the legacy
   number is already attached to the first phone.
3. **The phone you last used is the active one**, among the phones that are
   yours: a phone in your inventory that another character used is skipped, as
   though you were not holding it. Using the burner switches everything on
   screen and in the framework: its contacts, threads, photos, passcode,
   battery, and its number is what `GetPlayerByPhone` now returns for you. Using
   the first phone switches back. Dragging items between slots changes nothing;
   only the inventory's use action does.
4. Each phone has its own passcode, theme, block list, battery charge and
   external lock. Locking the burner with `LockPhone` locks only the burner.

What is and is not correlated between the two, for an owner deciding how much
anonymity a burner really buys:

- **Other players see nothing linking them.** A message from the burner's number
  carries the burner's number; a contact saved on one phone is not on the other;
  the block list is per phone.
- **The server links them by character.** Both `mica_devices` rows name the same
  `citizenid`, so do the `mica_phone_numbers` rows, and every device-owned row
  on either phone carries it. Messages the character writes from either phone
  name them as author. `mica_audit_logs`, the moderation ledger, is keyed on
  `citizenid` alone and never on a phone: an admin acting on reported content
  sees the character, not which phone sent it. Bank, Hodlr, Marketplace, Blabber
  and mail are one per character whatever phone is in hand.
- **A sold or lost burner keeps its trail, and the trail stays yours.** Nothing
  moves when somebody else picks the phone up: they hold a phone that reads
  closed, and its rows, its number and the messages sent from it stay recorded
  against the character who used it. Throwing a burner away does not detach it
  from you, and a used one cannot be passed on to somebody else (see "Robbery
  and trade"). The audit log and any messages already authored keep your name
  too, because authorship and evidence are the character's and not the device's.

That split is deliberate. A burner is anonymous to the people on the other end
of it, which is what the roleplay wants, and fully attributable to the operator,
which is what moderation needs.
