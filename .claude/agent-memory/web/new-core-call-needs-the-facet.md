# A new core call reaches an app only through its facet

An in-tree app such as Admin cannot import `web/src/services/`
(`sdk/boundary.test.ts`), and `useService('reports')` from an app called `admin`
fails `sdk/permissions.test.ts`, because only the app's own id, or `<appId>_…`,
is allowed. So a new typed call in `services/<x>.ts` is unreachable from the app
until the facet carries it, and that touches three files outside
`web/src/apps/`:

- `sdk/host/facets.ts`: the facet's member type (sdk lane, public surface);
- `web/src/host/facets/<x>.ts`: the in-process facet returns it;
- `sdk/host/iframe/facets/<x>.ts`: the iframe twin is typed `AsTwin<…>`, so it
  fails typecheck until it gets `fn('<x>', [], '<member>')`.

**Why:** MICA-430's brief fenced only the app, the service and the mock. The
lane found the gap after writing the service and had to stop for a fence change.

**How to apply:** when a brief adds a call that an app consumes, check `useX()`
→ `facets.x()` before you start, and ask for the three facet files in the fence
at the outset. Type the reply with `ActionOutput<typeof contract, 'action'>`
from `@mica/shared/contract`; apps may import that type-only, as
`darkchat/store.ts` does.
