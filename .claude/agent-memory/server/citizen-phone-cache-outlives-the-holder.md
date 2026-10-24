# A stolen phone's rows wait for its owner, on purpose

Three answers in a row to "where do a robbed player's new rows land":

- **Before MICA-436** a citizen-keyed cache (`activeByCitizen`) still named the
  phone the thief now held. `phoneForCitizen(victim)` filed notifications, line
  texts and dropped photos there, and the next handover walk gave them to the
  thief (MICA-339 F7). The fix checked the cache against `holderNow`.
- **MICA-436** made a phone its first user's for good. The thief was refused it,
  nothing moved, and the stale cache became right: rows waited for the owner.
- **MICA-438** removed the cache. A character has one phone, the `mica_devices`
  row of `kind = 'phone'` naming them. `phoneForCitizen` is that row, held or
  not. Any phone item opens the holder's own phone, so the thief opens the
  thief's phone, and the victim's new item opens the victim's phone with
  everything filed there meanwhile. That is MICA-339's "stashed keeps receiving"
  decision, with nothing to invalidate.

`devices.test.ts` "resolves a thief holding the victim's item to the thief's own
phone, and touches nothing" holds it: the thief's resolve reads only the thief's
rows, the victim's `phoneForCitizen` still answers the victim's phone, and a new
item opens it again.

Any new cache keyed by citizen or by source that names a device still needs the
question: who else can reach it, and what clears it? `activeBySource` is the one
left, cleared on `playerDropped` and by any resolve that finds none held.

Related: [[a-foreign-read-skips-the-owners-read]]
