# Adding a host facet touches eleven places

MICA-390 (`useDirectMessages`) as the worked case. Missing any one of these is
either a compile error, a red suite, or — for the pin — a silent fail-open:

1. `sdk/host/use<X>.ts` — `guarded('use<X>', appId).facets.<x>(appId)`; the
   barrel picks it up after `node scripts/generate-barrels.js`.
2. `sdk/host/facets.ts` — the member type; nouns from `sdk/vocabulary/<x>.ts`.
3. `web/src/host/facets/<x>.ts` + its line in `web/src/host/registerFacets.ts`.
4. `sdk/host/iframe/facets/<x>.ts` + its line in
   `sdk/host/iframe/registerFacets.ts` (`seam.test.ts` fails a twin not listed).
5. `sdk/permissions.ts` — four tables: `PERMISSION_OF`, `HOOK_OF_FACET`,
   `FACET_MEMBERS` (members must be names the twin file mentions),
   `MEMBER_APP_ARGS` (alphabetical; total by type, so it will not compile until
   classified).
6. `IframeHostServer.ts` `APP_SCOPED_FACETS` if the factory takes an app id.
   **Nothing fails if you forget this** — add a named test in the "app-scoped
   facets are pinned" describe, as `searchProvider` and `directMessages` have.
7. `export type` of the nouns in **both** `sdk/index.ts` and `sdk/addon.ts`.
8. `publicSurface.test.ts`: `BASELINE_EXPORTS` and `BASELINE_TYPE_EXPORTS` (both
   barrels — "publishes nothing nobody decided to publish" fails otherwise),
   plus `BASELINE_HOOK_RETURNS`, `BASELINE_TYPE_SHAPES` and the `Facets` shape
   row, so a later removal reads as a break.
9. `dataFacets.test.ts` key-parity case for the twin.
10. A `### For add-on authors` CHANGELOG entry naming the hook and its
    permission in code spans — `server/__tests__/sdkChangelog.test.ts` freezes
    `PERMISSION_OF`.
11. The mock, under `web/src/nui/mocks/services/`, keyed as the server
    registers.

Trap seen in (6)'s test: `IframeHostServer` builds one facet instance per pinned
`factoryArgs`, so two calls to the same facet record **one** build, not two.
