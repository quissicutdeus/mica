# Add-on hook types are narrower than Facets

Since 2026-10-19, `addon.ts` re-types ten hooks through
`sdk/host/iframe/addOnHooks.ts`. They return their facet minus `CoreOnlyMember`,
so `useKeybindsWrite().setBinding` no longer compiles in an add-on. Before, it
compiled and the shell refused it as "core only" at run time. Traps found while
building it:

- **`FACET_MEMBERS` is the wire, not the add-on surface.** 35 members work in a
  frame without crossing it: `storage.getItem`, the `display` defaults, `timer`,
  `persisted`, the `music` and `theme` helpers. A plain `Pick` over the rows
  would have hidden all 35. `ANSWERED_IN_FRAME` in `sdk/permissions.ts` lists
  them, and a member on neither list is hidden by default.
- **A named export on `addon.ts` beats its `export *`.** That is how the barrel
  narrows a hook without touching `sdk/host/facets.ts`. But
  `publicSurface.test.ts` parses named re-export lines, so the ten names have to
  be declared (`RETYPED_FOR_ADD_ONS`). Otherwise the add-on-only parity check
  fails.
- **`BASELINE_HOOK_RETURNS` reads `index.ts` only.** Without its own arm, the
  narrowing would be invisible to the break gate. `ADD_ON_HOOK_OMISSIONS` is the
  frozen difference, held to the live checker in both directions.
- **"The twin sends it" means a quoted call argument.** Twins also write
  `Twin['presets']` as a type index, so the regex is `[(,]\s*'member'`, not any
  quoted name.
- **In-tree add-ons do not see the narrowing.** `web/` maps `@mica/sdk` to
  `index.ts`, so Casino or Glimpse could still destructure `addReceivedMail` and
  typecheck. Only the core-flagged scan in `permissions.test.ts` catches an
  in-tree add-on importing a refused hook.

**How to apply:** when a row in `FACET_MEMBERS` shrinks, `permissions.test.ts`
fails until the hook is listed in `addOnHooks.ts`, and `publicSurface` fails
until the member is in `ADD_ON_HOOK_OMISSIONS`. Both are the break being written
down, so the same change bumps `SDK_CONTRACT_VERSION`. When a row is emptied,
`ADD_ON_REFUSED_PERMISSIONS` picks it up by derivation, but the literal in
`lib/permissionScan.ts` has to be edited by hand. See also
[A contract bump has runtime reach](contract-bump-has-runtime-reach.md).
