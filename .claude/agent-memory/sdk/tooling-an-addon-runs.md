# Tooling an add-on runs from node_modules

MICA-312 shipped `sdk/checks/` (the class scan, `Screen` sizing, role-token
opacity, and `@mica/sdk/stylelint`) for the template's `pnpm check`. Four traps,
none of which a suite here would have shown up front:

- **It has to be plain `.js`.** Node 26 strips TypeScript, but refuses to for a
  file under `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), and
  that is where an author's copy lives. So `checks/*.js` is JSDoc-typed, listed
  in `files` and in both tsconfig `include`s. It cannot import `lib/m3.ts`, so
  role names are read off the shipped `app.css`. `cef.test.ts` checks that list
  still covers `ROLE_NAMES`.
- **Spread the stylelint config, do not `extends` it.** stylelint resolves an
  extended config's plugin from that file's own directory. Under pnpm that is
  the store, which cannot see the author's devDependencies. The CLI resolves
  stylelint from `process.cwd()` with `createRequire` for the same reason.
- **stylelint-no-unsupported-browser-features 8.1.1 does not flag
  `color-mix()`.** It does flag `:has()`, `dvh`/`svh`, container queries and
  `rgb(from …)`. So `pnpm lint:css` passes `color-mix()`; `cssColorHits` in
  `checks/cef.js` covers it, both in the CLI and in `cef.test.ts`.
- **`postcss-html` at the top level means stylelint reads no `.css` file.** It
  parses the stylesheet as HTML and finds no `<style>`, so the result is an
  empty document with no warnings. Root `lint:css` ran like that until MICA-312
  (both the CLI flag and the config). Keep it in a `**/*.svelte` override only.
  `unparsedStylesheets` in `checks/addon.js` makes the CLI exit 2 if this
  regresses. Turning it on found 16 old hits in `sdk/*.css`, `docker/landing`
  and gitignored `web/docs`.
- **The template's tile class `bg-slate-500` never existed** in
  `app-utilities.css`, from MICA-175 until MICA-312's checker caught it.
  `scripts/new-app.js` (plus a `text-gray-300` in its `--service` view) and the
  e2e dev-addon fixture had the same dead classes. Nothing ran the scaffolder
  until `server/__tests__/newApp.test.ts`. It copies the dirs the scaffolder
  touches into a temp root and runs `checkAddonSources` over what it writes.

`publicSurface.test.ts` pins a tooling subpath in `TOOLING_SUBPATHS` (path only,
out of contract like the stylesheets) rather than freezing it in `ENTRY_POINTS`.
That table's machinery skips `default` exports, so a default-only config module
would not fit it.
