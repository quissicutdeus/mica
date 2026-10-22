# A surface with several controls: stretch one, hook styles on data attributes

When a tappable surface (a message bubble, a card) has to hold other controls,
do not nest them: ARIA allows a button no interactive descendants, and axe
reports `nested-interactive`. MICA-407 turned the bubble into a plain `<div>`
holding sibling `<button>`s. The bubble's own toggle gets
`::after { position: absolute; inset: 0 }` against the `relative` surface, the
other buttons sit at `relative z-10`, and the surface takes `isolation: isolate`
so that z-10 cannot paint over sticky panels. A tap anywhere else still hits the
toggle.

Three things that are easy to miss:

- **The toggle must stay unpositioned**, or its `::after` resolves against the
  toggle itself and stretches over nothing.
- **A class inside a component `<style>` fails
  `src/lib/utilityClasses.test.ts`**, because it counts every static class token
  as a missing utility. Hook the rule on a data attribute instead
  (`[data-bubble-toggle]::after`), as `shell/BootScreen.svelte` does.
- **A toggle can end up with no text** (a location-only message), so give it an
  `aria-label` for that case only; otherwise its content is its name.

A MediaThumb kept inside the toggle still finds it with `closest()` and gates
its streamer-mode reveal there (MICA-405). Everything here is older than
Chromium 103: `isolation` shipped in 41, `inset` in 87.

Two more from MICA-411 (the notification shade's rows):

- **Keep every bit of text a spec clicks inside the stretched button.** Text
  left outside it sits under the `::after`, and Playwright's hit-target check
  walks up from the button and never meets the text, so
  `getByText(body).click()` fails as "intercepts pointer events". Text inside
  the button retargets to it. So the button holds the content as block `<span>`s
  (headings and `<p>` are not phrasing content), and only the extra control is a
  sibling.
- **A stretched button turns off any gesture that refuses to arm on a button.**
  `lib/phone/sheetDrag.ts`'s `bodyShouldStart` checks `closest('button')`, so
  the shade's close-drag no longer starts on top of a row. Check the drag
  utilities before stretching a control over a draggable surface.
