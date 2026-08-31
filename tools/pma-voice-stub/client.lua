-- Stub of the three pma-voice exports gPhone's call path calls, for solo in-game
-- testing (MICA-55). See README.md in this folder for how to run it.
--
-- Does no actual voice routing. What it does is print every call, with an
-- argument, and complain loudly if `addPlayerToCall`/`removePlayerFromCall` are
-- ever called out of balance — that imbalance is exactly the channel-leak class
-- of bug `client/services/Call.ts`'s own tests were written to catch, and this
-- is the same check against the real client instead of a mocked one.

local inCall = false

local function log(fmt, ...)
  print(('[pma-voice-stub] ' .. fmt):format(...))
end

exports('setPlayerTalkingOverride', function(override)
  log('setPlayerTalkingOverride(%s)', tostring(override))
end)

exports('addPlayerToCall', function(callId)
  if inCall then
    log('addPlayerToCall(%s) — already in a call. A channel was never left.', tostring(callId))
  else
    log('addPlayerToCall(%s)', tostring(callId))
  end
  inCall = true
end)

exports('removePlayerFromCall', function()
  if not inCall then
    log('removePlayerFromCall() — called with no call joined. Harmless here, but check the caller.')
  else
    log('removePlayerFromCall()')
  end
  inCall = false
end)
