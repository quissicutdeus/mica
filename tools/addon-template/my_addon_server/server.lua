-- The server half of my_addon: a two-action note list.
--
-- micaOS does the guarding. Before a handler below runs, it has rate-limited the call,
-- checked the server owner has not switched the app off, resolved the player server-side
-- and parsed `input` against service.json — so `input.text` here is a string of 1 to 200
-- characters, and nothing else reached this far. What micaOS does NOT do is decide who may
-- touch what: `citizenid` is the one identity it vouches for, and every ownership check is
-- yours to write.

local RESOURCE = GetCurrentResourceName()

-- One source of truth: `pnpm build` writes service.json from src/service.ts, which is
-- also what the UI's calls are typed from. Edit that file and rebuild; never this JSON.
local raw = LoadResourceFile(RESOURCE, 'service.json')
local declaration = raw and json.decode(raw)
if type(declaration) ~= 'table' then
  error(('[%s] service.json is missing or unreadable — run `pnpm build` in the add-on ' ..
    'project and copy my_addon_server/ again.'):format(RESOURCE))
end

-- Storage. In memory, keyed by citizenid, and gone on restart: enough to show the shape.
-- A real add-on keeps its own tables through oxmysql in this resource — micaOS's schema is
-- not yours to add to — and puts the citizenid in every WHERE, so one player can never
-- read or change another's rows by naming an id.
local notesByCitizen = {}
local nextId = 1
local MAX_NOTES = 50

local handlers = {
  -- Each handler gets (citizenid, input, source) and answers within five seconds, with a
  -- value or a promise. Anything it returns goes back to the UI as the call's result.
  list = function(citizenid, _input, _source)
    return notesByCitizen[citizenid] or {}
  end,

  add = function(citizenid, input, _source)
    local notes = notesByCitizen[citizenid] or {}
    if #notes >= MAX_NOTES then
      -- A refusal the player reads: the UI's call rejects with this message, which the
      -- template's `useAppAction` shows as a toast. Any other failure — a Lua error, no
      -- answer in time — rejects with micaOS's generic one, and only this server's
      -- console says why.
      return { error = { message = ('You already have %d notes.'):format(MAX_NOTES) } }
    end

    local note = { id = nextId, text = input.text, created = os.time() * 1000 }
    nextId = nextId + 1
    notes[#notes + 1] = note
    notesByCitizen[citizenid] = notes

    -- Every phone of this citizen's that is online hears it through `useAppEvents`. At most
    -- once and never queued: a phone that is offline catches up through `list`, so a push
    -- is a nudge, never the only copy. It cannot fail this call, so its answer is only
    -- logged.
    local pushed = exports.mica:PushToApp(declaration.id, citizenid, 'note_added', note)
    if not pushed.ok then
      print(('[%s] PushToApp: %s — %s'):format(RESOURCE, pushed.reason, pushed.message))
    end

    return note
  end
}

local function register()
  local result = exports.mica:RegisterService(declaration, handlers)
  if result.ok then
    print(('[%s] serving %s'):format(RESOURCE, declaration.id))
  else
    -- `invalid_args` says what in the declaration was refused; `already_registered` means
    -- another resource holds this id.
    print(('[%s] RegisterService refused: %s — %s'):format(RESOURCE, result.reason, result.message))
  end
end

-- micaOS forgets every registration when it restarts, so register again whenever it starts.
AddEventHandler('onResourceStart', function(name)
  if name == 'mica' then register() end
end)

if GetResourceState('mica') == 'started' then register() end
