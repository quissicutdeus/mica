# MICA-405 streamer-mode axe pass

- `getAnimations({ subtree: true }).length === 0` never settles while a modal is
  open: the dialog's `animate-in` (`fill-mode: both`) stays in the list as
  `finished`. Filter on `playState !== 'finished'`, as `settleFrame` in
  `a11y.spec.ts` does, or a photo-picker scan times out on a screen that is
  perfectly still.
- Add-on frames (`?app=glimpse|spark|blabber`) are scanned by `AxeBuilder`
  through the iframe with no extra work; the failure target reads
  `iframe,<selector>`.
- The tablet has no blurred `MediaThumb` to scan: Settings' "From a photo"
  section is empty there because the per-device mock gives the tablet an empty
  gallery. Do not add a tablet streamer test until that mock carries photos.
- Snatchr feed and listing detail cannot show a picture in the browser mock
  (`marketplace:create` answers `attachments: []`); only the picker is
  reachable.
- Stripping `role`/`tabindex` off the overlay in the page (`page.evaluate`)
  removes every `nested-interactive` node and leaves
  `label-content-name-mismatch`: a second, separate defect (visible text "Tap to
  reveal" inside a button named "Open photo N").
- `PhotoPickerModal`'s `<h3>` trips `heading-order` on Snatchr's new-listing
  screen with streamer mode off too; it is a `KNOWN_OPEN` entry, not the
  overlay's.
