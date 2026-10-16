# A core still lists a character after announcing its unload

qbx fires `QBCore:Server:OnPlayerUnload`, then `Wait(200)`, then nils the player
(`qbx_core/server/player.lua:746-754`). ESX nils `ESX.Players` only in the
callback of an asynchronous save, which retries every 5s on failure. qb-core
clears straight after firing, with no window. So forgetting a source on the
unload event is not enough: a reseed walk inside the window puts the character
straight back.

**How to apply:** when you forget something on an unload event, also stop
whatever rebuilds it from the framework from re-adding it during the window.
MICA-382 does it with a `(source, citizenid)` mark in `FrameworkBridge` that the
reseed skips and the next load clears.
