# The endpoint harness runs every server timer on the wall clock

`scripts/lib/fivem-server-runtime.js` wraps `setInterval` around the real one,
so Battery's 5 s tick runs during `test:endpoints` exactly as on a server. It
writes `mica_battery` for every connected player, flow players included. Once a
minute a drain moves each held charge a whole percent. A tablet in use with no
charge held is loaded and written back at 100, a new row.

The access matrix diffs every table around each attack. A tick write that lands
between the two snapshots reads as the attack changing somebody else's row. The
matrix takes about 5 s, so this only shows on a slow run. MICA-474's longer flow
turned `messages:react.message_id` red on two inserts, A's and B's (rows
`#500000` and `#500001`), not a matrix player's.

What proved it was holding the cases 30 s after the parties connected
(`DIAG_DELAY_MS`), with every `mica_battery` change logged per case and the
table dumped with its write times. That reproduced both shapes of the failure.
The fix quiesces state, not the diff: `__resetBatteryState()` through the
harness bundle, then `settle()`, before the matrix resets its id ranges.

A new timer that writes rows will flake the matrix the same way. Look for one
first when a matrix failure names a table the action never touches.
