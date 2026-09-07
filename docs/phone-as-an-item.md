# The phone as an item: shops, robbery, confiscation and burners

micaOS does not ship a phone shop, a robbery script or a police confiscation
flow. Those belong to the server's own economy and job scripts, which already
decide who can buy what, what a robbery costs and what an officer may take. What
micaOS ships is the item model underneath them (MICA-219): a phone is an
inventory item with an id of its own, and the number, the data and the lock
belong to that id rather than to the character holding it. This page shows what
each of those scripts looks like on top of it, written from the code that
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
written into that slot's metadata under the key `phoneId`
(`server/services/Phones.ts`, `resolvePhone`). Where that key lands depends on
the inventory (`server/lib/framework/itemMetadata.ts`):

| Inventory                                       | Where `phoneId` is stored                                                             | Read | Write                                    |
| ----------------------------------------------- | ------------------------------------------------------------------------------------- | ---- | ---------------------------------------- |
| ox_inventory (qbx_core, or ox on qb-core / ESX) | the slot's `metadata` table, through `SetMetadata`, merged with what is already there | yes  | yes                                      |
| qb-inventory                                    | the item's `info` table                                                               | yes  | only if your build exposes `SetItemData` |
| es_extended's own inventory                     | nowhere: it stores quantities only                                                    | no   | no                                       |

The id is a 32-character hex string and nothing about it is a secret. A copied
id grants nothing on its own, because every read and write still names the
character presenting it as well (`docs/security.md`, and the handover rule
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

What happens on first use (`resolvePhone` in `server/services/Phones.ts`, and
`numberForPhone` in `server/services/PhoneNumbers.ts`), in order:

1. The item carries no `phoneId`. If the character has an **unclaimed identity
   phone** (`mica_phones.claimed = 0`), the item adopts it: that is the phone
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

There is nothing to script for the data. When a phone moves inventories intact,
the next player to **use** it becomes its holder, and the handover is what moves
everything:

- `resolvePhone` finds an item whose `mica_phones` row names somebody else and
  calls `handOver`, which runs `Repository.transferPhoneRows`: one
  `UPDATE … SET citizenid = <holder> WHERE phone_id = ?` across every table with
  a `phone_id` column. Contacts, notes, photos, places, settings, the passcode
  row, notifications, the call log, the block list, thread memberships and the
  battery charge all now belong to the thief. `docs/schema-and-services.md` has
  the table-by-table split, and why `citizenid` on those rows means "whoever
  holds the phone now".
- The number travels: `numberForPhone` transfers the `mica_phone_numbers` row to
  the holder, and a message or call to that number reaches the phone, whoever
  has it. The framework's `charinfo.phone` for the thief is written back to the
  stolen number the moment they use it.
- The passcode travels with the `mica_lockscreen` row, so a thief faces the
  victim's lock screen. That lock is a display state the client enforces, not a
  server boundary (`server/lib/LockState.ts` says so plainly), and a phone
  another resource locked with `LockPhone` stays locked in whoever's hand it
  lands.
- What does **not** move: the victim's Bank, Hodlr holdings, Marketplace
  listings, Blabber account, mail and high scores. Those are keyed on the
  character. Messages the victim wrote keep the victim as author; the thread
  membership follows the phone, which is what puts the conversation on the
  thief's screen.

The victim, holding no phone, sees a closed phone: the client relays the
inventory change (`client/services/DeviceItem.ts` listens for
`ox_inventory:itemCount`, `QBCore:Player:SetPlayerData`, `esx:addInventoryItem`
and `esx:removeInventoryItem`) and the server counts again and pushes the
answer. Buying a new phone gives them a fresh id and a fresh number; their old
contacts are on the phone that was taken. That is the model working as designed,
and a server that finds it too harsh should make robbery scripts return the item
rather than soften the model.

A robbery script that wants to _hand_ the item over rather than let the player
loot it has one rule: move the item with its metadata. In ox_inventory,
`RemoveItem` followed by `AddItem(target, 'phone', 1, metadata)` with the slot's
original `metadata` table is a robbery; the same pair without the table is a
theft that destroyed the phone and gave the robber a new one.

## Confiscation and return

Two independent controls exist, and a confiscation script normally wants both:

**Take the item.** Remove the phone from the player's inventory and put it in
the officer's, or in an evidence stash. The player's phone closes as soon as the
client relays the change, exactly as it does on a robbery. The data goes
nowhere: the rows keep their `phone_id`, with `citizenid` still naming the
player, because nobody has _used_ the item since. An officer who uses the
confiscated phone becomes its holder through the handover above and can read it,
which is realistic and worth knowing before you let a stash be that easy to
open.

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
everything where they left it: same id, same number, same data. If the officer
never used it, no handover ever happened and the rows never moved. If they did,
the player's next use hands it straight back. The failure to avoid is the one
from the first section: an evidence script that stores "1 × phone" as a count
and gives back a fresh item has destroyed the phone and handed the player a
blank one.

## Destroyed, dropped on death or traded

micaOS reacts to an item **leaving a player's hand** (the phone closes) and to
an item **being used** (the handover). It does not react to an item ceasing to
exist. There is no inventory event for "this item was destroyed" that every
framework agrees on, and a phone in a stash, on the ground, or in a dead
player's dropped inventory looks identical to one that is gone forever.

So when a phone item is destroyed, its rows stay exactly where they are: keyed
on a `phone_id` no item carries any more, with `citizenid` naming the last
holder, and a `mica_phones` row that is now permanently claimed. Nothing reads
them again, and nothing deletes them. The same is true of a phone dropped on
death and never picked up. A trade is not this case at all; it is a handover the
moment the buyer uses the phone.

What already covers some of that:

- **The orphan sweep** (`server/lib/orphanSweep.ts`) deletes the rows of a
  _character_ that no longer exists. It runs at resource start and when another
  server resource triggers `mica:server:shell:characterDeleted` with a
  citizenid. On qb it is a backstop for the schema's own `ON DELETE CASCADE`; on
  ESX it is the cascade. Delete the character and every phone they ever held
  goes with them. It does nothing for a destroyed phone whose owner still plays.
- **Notification retention** (`mica_notification_retention`, 30 days) prunes old
  notifications on every phone, destroyed or not.
- **Media retention** (`mica_media_retention`, off by default) hard-deletes
  media older than the window, and `micamedia prune` from the console runs that
  and the media orphan sweep now (`docs/in-game-commands.md`).
- **`mica_restore_window_days`** (30) is how long a soft-deleted contact, note
  or photo stays restorable. It deletes nothing past the window, on purpose:
  moderation depends on a soft-deleted row surviving.

There is no export or command today that says "this phone id is gone, drop its
rows". On a server where phones are destroyed often, the abandoned rows are
small and inert, but they are not reclaimed until the character is. An owner who
needs that has to delete `WHERE phone_id = ?` by hand across the device-owned
tables, in the order `docs/schema-and-services.md` lists them.

## A burner

Buy a second phone and use it. That is the whole recipe:

1. Using the second item mints a fresh id (the identity phone was already
   adopted by the first), so it is a new phone with none of the first one's
   data.
2. Its number is a fresh assignment: no number is on the item, and the legacy
   number is already attached to the first phone.
3. **The phone you last used is the active one.** Using the burner switches
   everything on screen and in the framework: its contacts, threads, photos,
   passcode, battery, and its number is what `GetPlayerByPhone` now returns for
   you. Using the first phone switches back. Dragging items between slots
   changes nothing; only the inventory's use action does.
4. Each phone has its own passcode, theme, block list, battery charge and
   external lock. Locking the burner with `LockPhone` locks only the burner.

What is and is not correlated between the two, for an owner deciding how much
anonymity a burner really buys:

- **Other players see nothing linking them.** A message from the burner's number
  carries the burner's number; a contact saved on one phone is not on the other;
  the block list is per phone.
- **The server links them by character.** Both `mica_phones` rows name the same
  `citizenid`, so do the `mica_phone_numbers` rows, and every device-owned row
  on either phone carries the holder's `citizenid`. Messages the character
  writes from either phone name them as author. `mica_audit_logs`, the
  moderation ledger, is keyed on `citizenid` alone and never on a phone: an
  admin acting on reported content sees the character, not which phone sent it.
  Bank, Hodlr, Marketplace, Blabber and mail are one per character whatever
  phone is in hand.
- **A sold or lost burner takes its trail with it.** Once somebody else uses it,
  the handover re-keys its rows to them and the number rings for them. The audit
  log and any messages already authored keep the original character's name,
  because authorship and evidence are the character's and not the device's.

That split is deliberate. A burner is anonymous to the people on the other end
of it, which is what the roleplay wants, and fully attributable to the operator,
which is what moderation needs.
