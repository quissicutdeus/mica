fx_version 'cerulean'
game 'gta5'

author 'quissicutdeus'
version '1.0.0'
license 'AGPL-3.0-or-later'
description 'A modern Phone for FiveM built in TypeScript'
repository 'https://github.com/quissicutdeus/gphone'

lua54 'yes'

server_script 'dist/server/**/*.js'
client_script 'dist/client/**/*.js'

ui_page 'dist/web/index.html'

files {
  'dist/web/index.html',
  'dist/web/assets/**/*',
  'dist/web/*.svg',
  -- Add-ons are fetched at runtime by `shell/state/registry.ts` (`./addons/<id>.js`) and
  -- are not part of the hashed `assets/` graph, so `assets/**/*` never covered them. FiveM
  -- serves only what is declared here, so every add-on 404'd — blabber, hodlr, notes, snek.
  'dist/web/addons/**/*',
}

