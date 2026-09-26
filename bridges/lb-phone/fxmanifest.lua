-- SPDX-FileCopyrightText: 2026 quissicutdeus
--
-- SPDX-License-Identifier: AGPL-3.0-or-later

-- A compatibility bridge (MICA-232): answers exports['lb-phone'] by forwarding to micaOS,
-- so a script written for lb-phone keeps working. It is not lb-phone. FiveM keys exports by
-- resource name, so this directory must be named exactly `lb-phone`, and it cannot run
-- beside a real lb-phone.
--
-- Optional, and ensured by nobody: copy it out of mica/bridges/ into resources/ and
-- `ensure lb-phone` after `ensure mica`. Hand-written JavaScript with no build step.
--
-- Needs these micaOS features, all landed:
--   MICA-223  the server SendMessage export
--   MICA-224  the client exports
--   MICA-226  callable numbers (CreateCall)
--   MICA-232  IsInCall, HasPhoneItem, GetSourceFromNumber, GetCitizenIdFromSource

fx_version 'cerulean'
game 'gta5'

name 'lb-phone'
description 'micaOS compatibility bridge for scripts written against lb-phone'
author 'quissicutdeus'
license 'AGPL-3.0-or-later'
version '1.0.0'

dependency 'mica'

-- Loaded in this order into one context per side: the table, the registrar, the side.
shared_scripts {
  'map.js',
  'runtime.js'
}
server_script 'server.js'
client_script 'client.js'
