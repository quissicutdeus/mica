# MICA-295 tablet parity — what the tablet sweep found

Written landing MICA-295 (tablet e2e parity: shared status-surface specs, tablet
notes/settings specs, a tablet a11y sweep, a `tablet-light` project, cef-floor
split). Two things worth keeping for next time.

## `notes/tablet.svelte`'s new-note sheet uses `variant="edit"`, not `variant="add"`

Unlike the phone (`add` for a fresh note, `edit` once one exists), the tablet
root passes `variant="edit"` to `NoteEditor` in **both** states. That changes
the content field's placeholder: `notes.markdownPlaceholder` ("Markdown
content...") always, never `notes.contentPlaceholder` ("Content (Markdown
supported)"). Cost three specs a 30s timeout each before the mismatch was found
via the error-context page snapshot. Check the actual rendered placeholder in a
component's tablet root before assuming it mirrors the phone one prop-for-prop —
the two roots share the editor component but not always the same props into it.

Also: the notes list row's truncated content preview (`line-clamp-2` span)
repeats the same text the detail pane shows, so an unscoped
`frame.getByText(...)` after selecting a note is a strict-mode violation
(matches the list row _and_ the detail pane). Scope to
`frame.getByTestId('notes-detail')` once a note is selected.

## Sidebar row accessible names are title+subtitle, not just the title

`settings/tablet.svelte`'s `sidebarRow` snippet renders both a title span and a
subtitle span inside the one `<button>`, so the accessible name is both strings
concatenated. A `getByRole('button', { name: 'Display', exact: true })` never
matches; use a leading-anchor regex (`/^Display/`) instead. Same trap would hit
any settings sidebar row assertion.

## Two real product a11y bugs found, not fixed here (out of e2e-lane scope)

Both are exempted via `KNOWN_OPEN` in `web/e2e/tablet/accessibility.spec.ts`,
same convention as `web/e2e/a11y.spec.ts`'s own list — see that file's doc
comment for why the convention exists (a named, reasoned exemption beats a red
gate nobody reads or a silently narrowed sweep).

- **Status bar clock/battery text, ~1.2:1 contrast, tablet + light mode only.**
  `StatusBar.svelte:182`/`:318` — foreground correctly follows the light
  scheme's `on-surface` (`#191b25`), but axe reads the background behind it as
  flat `#000000`/ `#040404` rather than `TabletFrame.svelte:105`'s wallpaper
  gradient. Present on the launcher and every tablet-capable app root (status
  bar is always mounted). Not on the phone, and not on the tablet in dark mode
  (dark text on a dark background still passes by luck, not by design) — nobody
  had run the tablet in light before this ticket, which is exactly why
  `tablet-light` exists. Root cause not chased further (product code, out of
  this lane's remit); worth its own ticket.
- **`ColorWheelPicker.svelte:284`'s lightness slider (and the opacity slider
  right below it) has no accessible label** — bare `<input type="range">`, no
  `aria-label`. Sits on `settings/panes/Display.svelte`, which
  `settings/tablet.svelte` opens **by default**
  (`pane = $state<Pane>('display')`); the phone only reaches it by drilling in,
  and `a11y.spec.ts`'s phone sweep never drills anywhere, so this was always
  there and never swept until the tablet root's default pane exposed it.

## Baseline vs. after (269c141d → MICA-295)

Baseline (269c141d, before any tablet-parity work): 371 passed / 7 skipped,
2:13.75 wall. After (082cb804): 394 passed / 7 skipped, 1:57.38 wall — faster
despite +23 tests, which is almost certainly run-to-run machine noise rather
than a real speedup; do not treat wall time deltas this small as signal without
a few more samples.
