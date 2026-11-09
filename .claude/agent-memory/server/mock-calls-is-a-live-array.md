# A snapshot of `emitNet.mock.calls` keeps growing

`phone.test.ts`'s `emitCalls()` returns `emitNet.mock.calls` itself, not a copy.
A case that runs several dials and compares what each sent (MICA-474's "held
equal to a block, whole") stored that array, and every later emit, including the
next dial's setup, was pushed into the earlier snapshot. The comparison then
failed on emits that belonged to a different dial.

`mockClear()` swaps in a new array. It does not empty the old one, so a snapshot
taken before the clear still collects everything up to it.

Copy it when you keep it: `sent: [...emitCalls()]`. `createCalls()` maps, so it
is already a copy. The failure is loud, as an inequality, but it reads as a
product bug: an `incoming` in the "blocked" snapshot looks like a leak.
