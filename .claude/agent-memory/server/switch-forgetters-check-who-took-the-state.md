# A switch forgetter keyed by source must check which character took the state

qbx's `CreatePlayer` seats the new character (`server/player.lua:1055`), waits
one client round trip, then announces `QBCore:Server:PlayerLoaded` (`:1064`). In
between, `getPlayer` already names the new character, so it can place or receive
a call. A `forgetOnPlayerLoaded` forgetter keyed only by source then ends that
call at the announcement and files it under the previous character.

**How to apply:** a forgetter for per-source state records which citizenid took
the state, and ends only state the previous character took. MICA-383 does it
with `keyCharacter` in `Phone.ts`. A forgetter registered `atLogout` must also
be idempotent, since a different character's load runs it again.
