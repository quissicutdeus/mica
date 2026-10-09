-- Stub of the pma-voice client exports micaOS's call path touches, for solo in-game
-- testing (MICA-55). See README.md in this folder for how to run it.
--
-- Does no actual voice routing. Since MICA-341 the server places both parties in a
-- call's channel (`server.lua`), so the only call-channel traffic this half should see
-- is the server telling it where it was put. Every client-side way into a channel —
-- `addPlayerToCall`, `setCallChannel`, `removePlayerFromCall` — goes through the
-- `pma-voice:setPlayerCall` net event, exactly as the real pma-voice's client does
-- (`client/module/phone.lua`), and `server.lua` says so loudly when micaOS's own client
-- is the one using it.

local callChannel = 0

local function log(fmt, ...)
  print(('[pma-voice-stub] ' .. fmt):format(...))
end

local function setCallChannel(channel)
  log('client setCallChannel(%s) — sent as pma-voice:setPlayerCall', tostring(channel))
  TriggerServerEvent('pma-voice:setPlayerCall', channel)
  callChannel = channel
end

exports('setPlayerTalkingOverride', function(override)
  log('setPlayerTalkingOverride(%s)', tostring(override))
end)

exports('setCallChannel', setCallChannel)
exports('SetCallChannel', setCallChannel)

exports('addPlayerToCall', function(channel)
  local call = tonumber(channel)
  if call then setCallChannel(call) end
end)

exports('removePlayerFromCall', function()
  setCallChannel(0)
end)

RegisterNetEvent('pma-voice:clSetPlayerCall', function(channel)
  log('the server put this player in call %s', tostring(channel))
  callChannel = channel
end)
