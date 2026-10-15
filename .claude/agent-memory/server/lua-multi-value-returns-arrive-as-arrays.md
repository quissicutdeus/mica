# A Lua export's second return value turns its answer into an array

A Lua export that returns several values reaches JavaScript as an **array**.
ox_inventory's `RemoveItem` refuses with `false, 'reason'`, which arrives as
`[false, 'reason']`. That is truthy, so `if (!removed)` let the battery bank
charge with nothing removed (MICA-325 review). The same shape showed on hoth in
MICA-304: `AddItem answered true,[object Object]`.

No suite sees it, because every stub returns the single value its author
expected. Read any answer from another resource through its first element
(`itemRemoved` in `server/lib/framework/runtime.ts`), then accept only a real
boolean, the way `moved` does for money. When stubbing, include one
`[false, 'reason']` case beside each bare `false`.

Since MICA-336 `moved` and `balanceOf` (money) read through the same
module-private `firstLuaValue` helper `itemRemoved` uses. Before that, a money
export's `true, …` read as refused: fail closed, but it refused a payment that
went through. ESX money is proved by the balance, not the return, so only the qb
and qbx paths changed.
