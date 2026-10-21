# axe `heading-order` is relative, so a dialog's level is too

MICA-406. axe 4.14's `heading-order` never fails the first heading on a page
(`getHeadingOrderOutcome` returns true at index 0). It fails a heading only when
it is more than one level below the heading before it in document order. A
dialog sits on top of the screen that opened it, and that screen's
`ScreenHeader` holds the `h1`, so an sdk/ui dialog's `h3` title fails and an
`h2` passes.

So a ticket that says "the first heading on screen is an `h3`" means the first
heading _in the dialog_. The `h1` behind it still counts.

**How to apply:** every sdk/ui dialog (`PhotoPickerModal`, `ReportDialog`,
`ConfirmDialog`) titles itself with an `h2` and is named by `aria-label`. The
shell's own modals (`AppCrashed`) do the same. A new dialog follows suit, with
no heading-level prop. A screen's own `h3` straight under its `h1` (Glimpse's
"New post", Contacts' "New Contact") is that app's defect, not the SDK's. Before
changing a title tag, grep `web/e2e` for `locator('h3'`: `navigation.spec.ts`
found ConfirmDialog by its tag.
