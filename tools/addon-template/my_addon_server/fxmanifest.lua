-- The server half of the template add-on: a FiveM resource of its own, beside micaOS
-- rather than inside it. Copy this folder into your server's resources/ and `ensure` it
-- after `ensure mica` — see "Your server half" in ../README.md.

fx_version 'cerulean'
game 'gta5'

author 'you'
version '1.0.0'
description 'Server half of my_addon, registered with micaOS through RegisterService.'

lua54 'yes'

-- micaOS answers your add-on's calls, so it has to be running before this registers.
-- `dependency` makes FiveM refuse to start this resource without it; the order in
-- server.cfg (`ensure mica` first) is what makes it already started when this one is.
dependency 'mica'

server_script 'server.lua'

-- `service.json` needs no entry: it is read on the server with LoadResourceFile, and
-- `files` is only for what a client downloads.
