fx_version 'cerulean'
game 'gta5'

author 'quissicutdeus'
version '1.0.0'
license 'AGPL-3.0-or-later'
description 'An open-source TypeScript phone for FiveM'
repository 'https://github.com/quissicutdeus/mica'

lua54 'yes'
node_version '22'

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
  -- The owner's own images (MICA-236): wallpapers under branding/wallpapers/ and the boot
  -- logo `mica_brand_logo` names, loaded by the NUI over https://cfx-nui-mica/branding/.
  -- FiveM serves only what is declared here, so an image outside this glob is a 404.
  'branding/**/*',
}
