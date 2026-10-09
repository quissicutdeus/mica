-- SPDX-FileCopyrightText: 2026 quissicutdeus
--
-- SPDX-License-Identifier: AGPL-3.0-or-later

-- The server half of the stub (MICA-341). micaOS's server puts both parties of a call
-- in its channel through the `setPlayerCall` export and takes them out the same way;
-- the client no longer joins by itself. This models the two ways into a channel the
-- real pma-voice has (`server/module/phone.lua`):
--
--   * the `setPlayerCall(source, channel)` export, which another resource calls; it
--     tells the player's own client through `pma-voice:clSetPlayerCall`, and
--   * the `pma-voice:setPlayerCall` net event, which **any client** can send for any
--     channel. The real one checks nothing; neither does this one, on purpose, so a
--     forged join behaves here as it would there and micaOS's own refusal is what you
--     watch for.
--
-- Both write `Player(source).state.callChannel`, which is what micaOS reads back.
-- No audio is routed. See README.md in this folder.

local channelOf = {}

local function log(fmt, ...)
  print(('[pma-voice-stub] ' .. fmt):format(...))
end

local function setPlayerCall(source, rawChannel, fromClient)
  local channel = tonumber(rawChannel)
  if not channel then
    return log('setPlayerCall(%s, %s) — not a number, ignored.', tostring(source), tostring(rawChannel))
  end

  local who = fromClient and 'its own client' or (GetInvokingResource() or 'unknown')
  local current = channelOf[source] or 0

  if fromClient and channel ~= 0 then
    log(
      '%s joined call %s by %s. micaOS no longer joins from the client: unless this is pma-voice restarting into the call it was already placed in, micaOS should take them back out within a tick.',
      tostring(source), tostring(channel), who
    )
  elseif channel ~= 0 and current ~= 0 and current ~= channel then
    log('setPlayerCall(%s, %s) by %s — moved from call %s without leaving it first.',
      tostring(source), tostring(channel), who, tostring(current))
  else
    log('setPlayerCall(%s, %s) by %s', tostring(source), tostring(channel), who)
  end

  channelOf[source] = channel ~= 0 and channel or nil
  Player(source).state.callChannel = channel
  if not fromClient then
    TriggerClientEvent('pma-voice:clSetPlayerCall', source, channel)
  end
end

exports('setPlayerCall', function(source, channel)
  setPlayerCall(source, channel, false)
end)

RegisterNetEvent('pma-voice:setPlayerCall', function(channel)
  setPlayerCall(source, channel, true)
end)

AddEventHandler('playerDropped', function()
  channelOf[source] = nil
end)
