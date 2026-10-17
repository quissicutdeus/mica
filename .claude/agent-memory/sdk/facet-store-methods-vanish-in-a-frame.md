# A facet store's methods vanish in a frame

`AsTwin` collapses every store member of a facet to a plain `Readable`, so a
store that carries methods in-process (`phoneNotification().toast.show`, a CRUD
store's `.add`) has **none of them** in a `core: false` add-on's iframe. The
facet type in `sdk/host/facets.ts` still says they exist, because the twin is
registered through one `as unknown as` cast, so nothing type-level catches a kit
primitive calling one.

MICA-254: `ReportDialog` and `PhotoPickerModal` called `toast.show`, and every
report submitted from Glimpse or Dark Chat threw `o.show is not a function`
after the report had already gone. Every core-app test passed, because they run
in-process.

**Why:** `toast.show` takes an `app`, so it is deliberately not in the twin or
in `FACET_MEMBERS` — a frame choosing `app` could wear another app's icon. The
fix was to feature-test `typeof toast.show === 'function'` and fall back to
`sendNotification`, which the frame is already answered on and which takes no
`app`.

**How to apply:** any `sdk/ui/` primitive that reaches a facet store's method
needs a frame-side test that swaps in the real twin from
`sdk/host/iframe/facets/` over a mocked `../host/iframe/remote` (see
`ReportDialog.test.ts`). Also: a kit row in `sdk/permissions.ts` must equal what
the component's host imports reach, children included. `PhotoPickerModal` was
`'media'` without the `notifications` its `usePhoneNotification` needs; fixed
after MICA-254, and `permissions.test.ts` ("every kit row is exactly what…") now
holds every kit row to that. `sdkChangelog.test.ts` passed that re-gate by
coincidence, because an older entry already named both names. A green run there
does not mean the entry's wording is still true.
