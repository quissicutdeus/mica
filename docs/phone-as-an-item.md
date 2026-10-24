# The phone as an item: a key to your own phone

micaOS does not ship a phone shop, a robbery script or a police confiscation
flow. Those belong to the server's own economy and job scripts, which already
decide who can buy what, what a robbery costs and what an officer may take. What
micaOS ships is the item model underneath them (MICA-438): **a phone item is a
key, not a phone.** A character has exactly one phone, and its number, its data
and its lock are theirs. Holding any phone item opens that phone and no other.
This page shows what each of those scripts looks like on top of it, written from
the code that implements it, so an owner asking "how do I sell phones" on day
one has an answer rather than a missing feature.

Everything about the item assumes `mica_phone_item` is set. With it empty, which
is the default, the phone is not gated at all: every character has the same one
phone, always in hand. Setting it changes only whether a player has to be
holding a key to open that phone. Turning the gate on or off changes nobody's
number ("Turning the gate on and off", below). The README's "The phone as an
item" section covers the gate itself; this page picks up where it stops.

## The item is a key

The item is whatever `mica_phone_item` names, defined in your inventory's own
terms. The definitions per inventory are in the README; the short version is
that qb-core and ox_inventory both ship an item called `phone` already, so
`set mica_phone_item "phone"` needs nothing else on those.

The gate is a count (`holdsDevice` in `server/lib/deviceItem.ts`). A player
holding at least one phone item has a phone; a player holding none has a closed
phone. Which copy, which slot, what the copy carries and who bought it are never
asked. What the player then opens is **their own phone**: the one `mica_devices`
row with `kind = 'phone'` that names their `citizenid`, created the first time
the server needs it (`identityDevice` in `server/services/Devices.ts`). A
request is answered from that row, found by who is asking and by nothing on the
item. Somebody else's copy in your hand opens your phone, and your copy in their
hand opens theirs.

So micaOS neither reads nor writes anything on the item, and four things follow:

- **Every inventory that can be counted works the same.** That is ox_inventory's
  `GetItemCount`, a qb player's `GetItemByName` and an ESX xPlayer's
  `getInventoryItem`. ox_inventory is no longer the floor: the model needs no
  per-item metadata, so qb-inventory and es_extended's own inventory are
  first-class. The one inventory-specific part left is the usable-item hook that
  opens the phone when the item is used.
- **A `deviceId` an earlier build wrote into an item's metadata is ignored.**
  Nothing reads it and nothing removes it.
- **A duplicated item is another key to the same phone.** Item duplication is
  among the commonest exploits on a FiveM server, and under this model it hands
  the exploiter nothing they did not already have.
- **The tablet is the same, with its own item and its own row.**
  `mica_tablet_item` gates it, a character has one tablet (`kind = 'tablet'`),
  and a tablet has no number.

The row's `device_id` is 32 hex characters from `randomBytes(16)`, and every
device-owned row is keyed on it. Since MICA-438 it is written nowhere outside
the database, and nothing about it is a secret: every read and write names the
character presenting it as well (`docs/security.md`).

## Turning the gate on and off

The phone is the same row whether `mica_phone_item` is set or not
(`identityDevice` finds it by the character in both cases), and so is its
number, so setting or clearing the convar changes nobody's contacts, messages,
photos, settings or number. The number sync takes the character's phone, the one
in hand on a gated server and `identityPhone` where nothing is counted, and
hands it to `numberForPhone` in `server/services/PhoneNumbers.ts` either way
(MICA-439): the number already on that phone; failing that, the character's
**legacy number** (a row with no `device_id`) attached to it; failing that, a
fresh one. A number attached while the gate was on is therefore still the one
used after it is cleared, and the other way round. Before MICA-439 the ungated
path read only the legacy row, missed the one already on the phone, was refused
the framework's number by `number_unique`, and issued a second number while
calls and texts went on carrying the first.

**On an ungated server the legacy number is attached too, on upgrade.** Each
character's legacy row is attached to their phone on that phone's first number
sync after the update (`attachToPhone` in
`server/repositories/PhoneNumberRepository.ts`). The number does not change, no
version row is written, and it works on any schema this code runs on, so an
owner runs nothing; `micaschema apply` still gates MICA-430's versioned edits as
before, and not this. A row from before MICA-436 that sits on a phone and names
another character is detached back to that character as a legacy number
(`detachForeign`), logged once by token, and their next sync attaches it to
their own phone. ESX has no number rows to attach, and standalone has no item
gate to turn on or off.

## Selling a phone

A shop sells the item; micaOS does the rest the first time the phone is needed.
Nothing needs to be created ahead of time, nothing is minted into the item, and
no export needs to be called. A shop is selling a key, so a buyer who already
has a phone is buying a spare.

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

What happens the first time the server needs a character's phone
(`identityDevice` in `server/services/Devices.ts`, and `numberForPhone` in
`server/services/PhoneNumbers.ts`), in order:

1. The character has no phone row, so one is created, and the new-device hooks
   run after the answer is sent: the default contacts are seeded, once. A player
   who deletes a seeded contact is never re-seeded, because nothing re-creates
   the phone.
2. A number is settled. A number already on this phone stays. Failing that, the
   character's **legacy number** (the one they had before numbers followed
   phones, copied in from `charinfo.phone` by migration) is attached to this
   phone. Failing that, a fresh number is assigned, preferring whatever the
   framework already had for them.
3. The framework is told: on qbx_core through `SetCharInfo`, on qb-core through
   `SetPlayerData`, so `GetPlayerByPhone` and dispatch see the number. On ESX
   numbers stay the character's, because there is no standard setter.

So a character's phone is a continuation of who they were, number included, and
that does not depend on which item they happened to hold first. Every phone item
they ever hold after that does none of the above: it opens the phone that
already has its number and its data.

A shop that wants to sell a phone with a number chosen at the counter has no
export for that today. `RegisterNumber` is for a resource claiming a callable
number of its own, not for assigning one to a player.

## Robbery and trade

There is nothing to script for the data, because **nothing moves and nothing
needs to.** The phone is the character's own row and the item only opens it, so
a robbery script moves a key. Say a thief ends up holding a victim's phone item:

- **The thief opens their own phone.** Holding a phone item is holding a phone,
  so the thief's gate is open, and the server answers the thief's requests from
  the thief's `mica_devices` row (`resolveDevice` in
  `server/services/Devices.ts` looks it up by their `citizenid`, never by the
  item). It is a phone of their own: its own contacts, threads, photos, passcode
  and number, created new the first time they need it. Nothing on the victim's
  phone is reachable from it.
- **The victim's phone closes.** The client relays the inventory change
  (`client/services/DeviceItem.ts` listens for `ox_inventory:itemCount`,
  `QBCore:Player:SetPlayerData`, `esx:addInventoryItem` and
  `esx:removeInventoryItem`), the server counts again and pushes the answer, and
  a victim holding no other phone item sees a closed phone. A request that
  arrives anyway is refused with `server.phone.notHeld` ("You are not holding a
  phone.").
- **The victim buys another phone item and has everything back.** Contacts,
  notes, photos, places, settings, the passcode, notifications, the call log,
  the block list, thread memberships, the battery charge and the number are all
  still keyed on their phone, so it is as though the phone had been restored
  from a backup. The item they buy is not the one that was taken, and that does
  not matter.
- **Getting the stolen item back changes nothing.** It is one more key.
- **What arrives meanwhile waits for the victim.** A notification, a dropped
  photo or a line text filed on a character's behalf lands on their own phone
  (`phoneForCitizen`), and so does a text addressed to their number or a call
  logged against it (`readPhoneIdByNumber`). The thief's phone is a different
  row and never sees any of it. Like a phone in a stash, the victim's keeps
  receiving, and the victim reads it once they hold an item again.
- **The number stays with the victim.** `numberForPhone` settles the number of
  the phone its caller's character owns, so the thief's `charinfo.phone` is
  never rewritten to the victim's, and `mica_phone_numbers` keeps naming the
  victim.
- **The passcode never comes into it.** The lock screen is a display state the
  client enforces, not a server boundary (`server/lib/LockState.ts` says so
  plainly). That would matter if a thief could reach the victim's phone to be
  stopped by it, but the server picks the phone by who is asking, so there is no
  such case to defend.

`docs/schema-and-services.md` has the table-by-table split between what is on
the phone and what stays with the character. For a thief it is the same answer
either way: they are given their own, and the owner's is not theirs to reach.

**Trade is trade in keys.** Selling, giving or swapping a phone item gives the
other player a key to _their_ phone, whatever the seller put on theirs. A buyer
with no phone yet opens a new one; a buyer who has one opens theirs. The seller
keeps their phone and everything on it, and opens it again with any phone item.
So a phone cannot be passed on with its contents, and a second-hand phone is
worth exactly what a new one is. A server that wants "sell your phone with all
your contacts on it" cannot have it from micaOS.

A robbery script therefore has one thing to decide, and it is not about data:
how much a stolen item costs the victim. The only cost under this model is the
price of a new item, and the victim's own phone is what comes back with it.

## Confiscation and return

Two independent controls exist, and a confiscation script normally wants both:

**Take the item.** Remove the phone from the player's inventory and put it in
the officer's, or in an evidence stash. The player's phone closes as soon as the
client relays the change, exactly as it does on a robbery. The data goes
nowhere: the rows keep their `device_id`, with `citizenid` still naming the
player. An officer who uses the confiscated item opens the _officer's_ phone,
not the player's, so there is nothing for them to read. micaOS does not ship a
way for one player to read another's phone, and a server that wants one has to
build it as its own thing.

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

**Returning the phone** is moving a phone item back, then
`SetPhoneEnabled(source, true)` if it was disabled. Nothing was handed over to
be handed back: the player uses it and finds everything where they left it, same
number and same data. It does not even have to be the same item. An evidence
script that stores "1 × phone" as a count and gives back a fresh one has
returned the phone.

## Destroyed, dropped on death or traded

micaOS reacts to an item **leaving a player's hand** (the phone closes) and to
an item **being used** (it opens the holder's own phone). It does not react to
an item ceasing to exist, and with this model it has nothing to react to. Every
row is keyed on the character's phone, not on an item, so a destroyed item, a
phone dropped on death and never picked up, and a phone in a stash all leave the
character exactly where a lost item always does: without a key, and able to buy
another. Nothing is left on an id that no item carries, and nothing needs
cleaning up. A trade is not this case at all; see "Robbery and trade".

What does leave rows nobody can reach is a **deleted character**. Their phone
row and the rows on it stay live (`mica_devices`, `mica_phone_numbers`,
`mica_battery` and `mica_lockscreen`, kept by `CHARACTER_EXCEPT` in
`server/lib/shell.ts`), but a phone is found by its character, so on qb and qbx
no one resolves to it again. **ESX is the exception (MICA-440):**
esx_multicharacter reuses `char<slot>:<license>` as a slot's identifier, so a
new character created in a deleted character's slot has the same citizenid and
inherits that phone, and may meet its passcode. What covers some of that:

- **The orphan sweep** (`server/lib/orphanSweep.ts`) hides the rows of a
  _character_ that no longer exists (`erased`, MICA-428: nothing is deleted). It
  runs at resource start and when another server resource triggers
  `mica:server:shell:characterDeleted` with a citizenid. On qb it is a backstop
  for the schema's old `ON DELETE CASCADE`; on ESX it is the cleanup. It leaves
  the device rows live, as above.
- **Notification retention** (`mica_notification_retention`, 30 days) hides old
  notifications on every phone.
- **Media retention** (`mica_media_retention`, 365 days by default since
  MICA-167; `0` or `off` keeps media forever) expires media older than the
  window, keeping the row, and `micamedia prune` from the console runs that and
  the media orphan sweep now (`docs/in-game-commands.md`).
- **`mica_restore_window_days`** (30) is how long a soft-deleted contact, note
  or photo stays restorable. It deletes nothing past the window, on purpose:
  moderation depends on a soft-deleted row surviving.

Nothing deletes a row, so a deleted character's few device rows are small and
inert, and are never reclaimed. An owner who needs that has to delete
`WHERE device_id = ?` by hand across the device-owned tables, in the order
`docs/schema-and-services.md` lists them.

## Why a key, and what it rules out

This is the second model, and the first ran in no live server. From MICA-219 a
phone was an item with an id of its own, minted into the item's metadata. A
character could hold several, each with its own number and data, and a phone
could change hands. That rested on item metadata, which any resource can write
and which duplication exploits copy, and it needed an inventory with per-item
metadata to work at all. MICA-436 removed the handover, because a duplicated or
stolen phone was a full read of its owner's. What was left was a phone nobody
could pass on and a player who had to remember which of their phones to use.

The decision in MICA-438 is the owner's, in these terms: nobody should be able
to buy a burner; there is one keybind for the phone, and nobody should have to
remember which phone to open; and a player whose phone is stolen buys a new one
and has everything back, as if from a backup. The identity therefore moved from
the item to the citizen, which is what this page describes. It rules out, and
micaOS will not do for a server:

- **A second phone.** There are no burners: a second item is a spare key, with
  no number or contacts of its own.
- **Passing a phone on with its contents.** A phone item carries nothing.
- **A phone that a thief can read, or that a robbery can brick.** The thief has
  their own, and the victim's is reachable with any item.
- **Resetting a phone for its next owner.** MICA-437 asked for it, and was
  closed as unnecessary: there is no next owner.

## A character with more than one phone row

Only a database an earlier build of micaOS ran on can have this, and a server
that never ran one has none. Under the first model a character who used two
phone items had two `kind = 'phone'` rows. The rule now is that **the newest row
wins**: `identityRows` in `server/services/Devices.ts` orders a character's rows
by `updated_at` newest, then by the highest `id`, and `identityDevice` takes the
first. Nothing bumps `updated_at` when a phone is used, so this is not "most
recently used"; in practice it is the last row an earlier build created or
claimed. The others are left exactly as they are. The console says so once per
character per start, but it names the character and the row it took only by the
short token every log line uses (`who`, MICA-433), which gives nothing back. To
find them, ask the table:

```sql
SELECT citizenid, COUNT(*) AS phones
FROM mica_devices
WHERE kind = 'phone' AND status = 'active'
GROUP BY citizenid
HAVING COUNT(*) > 1;
```

Nothing merges the rows, and nothing reads the older ones again. The data on a
phone that lost is still in its tables, keyed on an id the character no longer
resolves to. An owner who wants it back has to move it with SQL, across the
device-owned tables in `docs/schema-and-services.md`.
