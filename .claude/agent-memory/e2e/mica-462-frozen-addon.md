# A frozen add-on's own guard refuses first; the shell's refusal needs a raw call

MICA-462 fixture: `web/e2e/fixtures/frozen-addon/`, booted through the
`?addonDev=` route of `dev-addon.spec.ts` with `page.route` serving its
`entry.json` and bundle.

- The catalog route cannot be used in e2e: it needs `mica_addon_hosts`, and the
  mock transport answers none. The dev route refuses any id the build ships, so
  the fixture needs an id of its own.
- The template's build fails a bundle that imports a hook its manifest does not
  declare. To get an undeclared call, declare the permission in the manifest and
  leave it out of `entry.json`: the dev grant is the entry's `permissions`.
- The shell's refusal is reached only by bypassing that guard: the probe posts a
  hand-built `{kind:'call', id, facet, factoryArgs, member, args}` to
  `window.parent` and reads the `{kind:'reply', ok:false, error}` back. Use an
  id far above the SDK transport's counter so the two do not collide.
- The hook itself throws `AppPermissionError` in the frame, at the hook call.
  Call it inside a `try`, never during component setup, or the shared fixture
  fails the test on an `Uncaught (in promise)` line.
- A launcher badge needs `badgeStore`, which a catalog entry cannot carry. The
  only badge a non-bundled add-on has is `useNotifications(id).unreadCount`,
  bumped by any toast with `app: id`.
- zsh aborts a whole command on an unmatched glob such as `web/.env*` or
  `--include=*.ts`, so a grep chain can silently not run. Quote globs.
