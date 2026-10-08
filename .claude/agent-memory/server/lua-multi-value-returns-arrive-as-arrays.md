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

`moved` and `balanceOf` (money) do not unwrap arrays yet. They refuse an array,
which fails closed, so a multi-value money export reads as refused rather than
as moved.
