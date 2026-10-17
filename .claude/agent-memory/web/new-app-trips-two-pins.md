# A new app trips two pins outside `apps/`

Adding `web/src/apps/<id>/` by hand (not `pnpm new:app`) fails two suites before
a line of the app is wrong (MICA-253, Glimpse):

- `sdk/appContract.test.ts` "covers every app in apps/" — wants an
  `import <Pascal> from '../web/src/apps/<id>/index.svelte'` and an
  `<id>: <Pascal>` row in `APPS`. `new:app` writes both; by hand it is an `sdk/`
  edit, so a `web` lane reports it.
- `web/src/lib/utilityClasses.test.ts` `COMPUTED_CLASS_RATCHET` — every app's
  `Icon.svelte` is `class={className}`, a computed expression, so each new app
  raises the count by one. `new:app` does **not** bump it. Check the printed
  list holds only the new Icon, then bump.

Also: `useAppAction().run` resolves to a boolean, never the work's return value
— capture a created row in the closure (`let x = null as T | null`, so TS does
not narrow it to `null`).
