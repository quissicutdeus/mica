# Making an overlay a dialog can break an unnamed e2e locator

MICA-410 gave Blabber's full-screen composer `role="dialog"`. The composer opens
`PhotoPickerModal`, itself a dialog, from inside it, so with both up there are
two `dialog` roles. `web/e2e/a11y.spec.ts` (the "blabber feed" surface) located
the picker as a bare `frame.getByRole('dialog')`, which then matches two
elements and fails Playwright's strict mode, while every unit suite stays green.

**Why:** the e2e suite is not the web lane's to run or edit, so the break only
shows in the lead's verify, long after the lane reported.

**How to apply:** before giving any surface a dialog role, grep `web/e2e` for
`getByRole('dialog')` with no `name` on a path that can open a nested dialog
from the new one, and name it in the report for the e2e owner. To get a
`core: false` add-on's `index.svelte` up in a unit test, `renderApp` plus a
mocked `fetchNui` that answers `svc` by `{ service, action }` works:
`accounts:mine` takes `{ rows, limit }` and a paged store takes
`{ rows, nextCursor }`.
