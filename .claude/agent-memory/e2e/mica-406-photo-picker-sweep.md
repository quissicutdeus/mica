# MICA-406 photo-picker axe sweep

- `heading-order` is relative to what is on screen. The picker's `h3` fired
  where the screen held only an `h1` (Snatchr, Blabber), not under Spark's `h2`.
  Where a failure sits beside the dialog, dump the headings
  (`closest('[role=dialog]')`) before blaming the modal: Glimpse's composer and
  Contacts' form fail at their own `h3`.
- Messages' "Photo" button opens nothing: `MessageComposer.showPicker` is never
  set, and `index.svelte`'s `showPhotoPicker` has no reader. Dead since
  86837c87. A picker sweep of Messages cannot be written until it is wired.
- Glimpse and Blabber `EditProfile` only name `PhotoPickerModal` in a comment.
- The bash guard refuses a pipe character inside a quoted `-g` argument as a
  piped gate; run the whole spec file instead.
