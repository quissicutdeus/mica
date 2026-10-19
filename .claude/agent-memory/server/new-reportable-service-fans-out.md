# A new reportable add-on service fails ten pinned lists

Adding Glimpse (MICA-253: `glimpse` + `glimpse_comments`, both reportable, one
reactable) turned these red, and only the full `pnpm test:unit:server` run
showed all of them:

- `orphanSweep.test.ts` `REPORTABLE_TABLES`
- `ownerConfig.test.ts` service-to-app pairs
- `moderationRestore.test.ts` — `FALLBACK` **and** the "declares the N
  reportable tables" count, plus the service imports at the top
- `privacy.test.ts` `EXPORTED_COLUMNS` (every table carrying `citizenid`, child
  tables included)
- `addonDiscovery.test.ts` — green only once the web lane's `core: false`
  manifest is on disk
- `reports.test.ts` — does not fail, but its "every reportable table" walk
  covers a table only if the file imports the service; its fake `world()` needs
  a branch for any visibility rule that is not `FROM \`t\` WHERE \`id\` = ?`
- Outside the server fence: `privacyLabels.test.ts` wants
  `yourData.cat.<table minus mica_>` in `web/src/apps/settings/locales/en.json`
  and `de.json`; `serverMessages.test.ts` wants new keys in
  `web/src/shell/locales/server.*.json`; `convars.test.ts` a README row;
  `changelog.test.ts` every new table in a code span under Action required.

**Why:** each list is a deliberate pin, and a lane brief rarely names all of
them. **How to apply:** before reporting a new service, run the full server
suite and name the out-of-fence four to the lead in the first message, so the
catalog and doc lines can land alongside rather than after review.

An add-on that is **not** reportable still fails six (Casino, MICA-82,
2026-10-18): `ownerConfig`, `privacy` `EXPORTED_COLUMNS`, `privacyLabels`,
`addonDiscovery`, `convars` and `changelog`. `orphanSweep` and `citizenIdWidth`
stay green, even with a `citizenId` generated column. `generateLocales` goes red
too, but that one is the web lane's catalog waiting on `pnpm generate:locales`.
