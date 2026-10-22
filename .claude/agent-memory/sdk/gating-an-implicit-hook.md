# Gating an implicit hook, or making a permission core only

MICA-433 moved `useSearchProvider` from `null` to a new `search` permission,
made `admin` refused on every add-on, and took `citizenid` off `account`. What
bit, beyond the eleven places in [Adding a host facet](adding-a-facet.md):

- **The first caller may be an in-tree add-on outside the lane's fence.** Notes
  is `core: false` and the only search provider. `permissions.test.ts`'s "covers
  every capability" arm fails until its manifest declares the new permission.
  Grep the hook's callers and check each one's `core` before starting, and ask
  for the manifest line up front.
- **A new permission needs three Store entries.** The `ICONS` record in
  `web/src/apps/store/appInfo.ts` (typed `Record<AppPermission, …>`, so it fails
  to compile), `permission.<name>` in every Store locale (`appInfo.test.ts`),
  and `pnpm generate:locales` for the root `locales/` copies.
- **Take the facet out of `SAFE_IMPLICIT_FACETS`** once it is not implicit, and
  fix the `APP_SCOPED_FACETS` pin test, which used to run with no permissions.
- **`sdkChangelog.test.ts` can pass by accident.** Its matcher wants the
  permission name as an identifier anywhere in a code span under
  `### For add-on authors`. The old MICA-286 entry's `` `search(needle)` ``
  satisfied `search`, so the gate stayed green with no entry. Before trusting
  green, grep the section for the name.
- **`ADD_ON_REFUSED_PERMISSIONS` is derived, so it is fragile.** Emptying a row
  lands a permission there, and giving the row a member back silently takes it
  out. `CORE_ONLY_PERMISSIONS` pins `admin` regardless, and a test holds its
  facets' rows empty.
- **Don't apply the host's first-message refusal to the whole refused list.**
  The "refused at the shell" cases grant `lock-screen-write` on purpose to prove
  `requireMember` alone refuses. A frame-wide check on every refused permission
  hid that proof, so the host check is `CORE_ONLY_PERMISSIONS` only.

**How to apply:** for any hook moving behind a permission, list its callers'
`core` flags first, then expect the Store's three entries, the changelog
wording, and `docs/writing-an-app.md` to be someone else's edit.
