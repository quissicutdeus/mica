# A loop through the integration door meets the limiter at 60

The door (MICA-397, `server/lib/integrationDoor.ts`) runs an action's own
`dispatch`, limiter included: `rateLimit.ts` allows 60 calls per source, per
service, per action, per minute (`mica_rate_limit`). A synthetic player keeps
its source across re-seeds, so a scenario that loops a draw — "start rounds
until one instantly busts" — is refused `server.rateLimited` on call 61, and
`call()` in `integration/lib/door.ts` throws on it.

MICA-397's brief asked for 200 `crashStart` cycles at the default 3% edge. That
cannot run. `casino-instant-bust-is-settled-in-the-reply` instead sets
`mica_casino_crash_edge_pct` to 20 with `SetConvar` (Casino reads it per call;
`config` confirms micaOS saw it) and caps at 50 starts, P(miss) ≈ 1.4e-5.

The other way to make a random draw deterministic without touching the service:
read the stored outcome from the table right after the start (`crash_point`),
and keep or discard the round on it — `casino-crash-busts-on-the-server-timer`
picks a point ≤ 2.00× so the timer's bust is at most ten seconds out.

A scenario's own time also counts: the suite's whole budget is 220 s
(`integration/server.ts`), and the stale-sweep scenario already takes up to 85.
