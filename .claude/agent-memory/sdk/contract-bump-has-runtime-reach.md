# A contract bump has runtime reach

Bumping `SDK_CONTRACT_VERSION` (`sdk/version.ts`) moves more than a number in a
doc. Found on the bump to `'2'` (2026-10-19): `onAppMount` and the three
settings plumbing functions left the surface. That bump was flattened back to
`'1'` the same day, because SDK 1 was unreleased and nothing outside this repo
consumed it, so this note records the mechanism, not a live version.

- **The shell refuses the old stamp.** `assertContractSupported` in
  `web/src/shell/state/registry.ts` (install) and the `hello` check in
  `IframeHostServer.ts` (hydrate) compare `manifest.sdkContract` for equality.
  Every published add-on stamped with the old number stops loading. An add-on
  with no stamp is never refused.
- **The public catalog URL moves.** `publicAddonCatalogUrl` in
  `shared/addonConfig.ts` keys it as `mica.gg/addons/sdk-<n>/catalog.json`, and
  `scripts/generate-catalog.js` writes it from the same constant. The deploy has
  to publish the new path, or the Store shows an empty catalog.
- **`server/__tests__/sdkChangelog.test.ts` wants a `v<n>` entry** under
  `### For add-on authors` in CHANGELOG.md, which the sdk lane usually may not
  edit. Ask the lead for it before the bump, not after.
- **Everything at the top of `sdk/host/` is on the published `.` entry.**
  `addon.ts` does `export * from './host/index'`. So a re-export inside a hook
  file (`useStorage.ts` re-exported `hydrateSettings`) is published contract,
  and removing it is a real bump. That is unlike an `index.ts`-only name: see
  [Removing from index.ts is not a bump](index-barrel-removal-is-not-a-bump.md).
  `sdk/host/seam/` is not globbed, so moving a name there needs no generator
  change.

**How to apply:** before bumping, grep `SDK_CONTRACT_VERSION` across `web/src`,
`shared/`, `server/` and `client/`, and put the refusal and the catalog move in
the report as consequences, not footnotes. Also grep every importer of a removed
name by path, tests included. The re-export's importers were three files, not
the one the brief named.
