-- SPDX-FileCopyrightText: 2026 quissicutdeus
--
-- SPDX-License-Identifier: AGPL-3.0-or-later

-- mica-integration (MICA-302): micaOS's server behaviour, proven inside a real FXServer.
-- Hand-written, unlike mica's own manifest: this resource is only ever started by the release
-- harness, with `set mica_integration "1"`, after `ensure mica`. server.js is integration/server.ts
-- bundled by esbuild.

fx_version 'cerulean'
game 'common'
node_version '22'

server_script 'server.js'

dependency 'mica'
