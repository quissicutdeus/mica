# axe 4.14 turns on `label-content-name-mismatch`

Found on MICA-401 (2026-10-20). Two changes in axe-core 4.14.0, read from the
two `axe.js` builds side by side:

- The rule lost its `experimental` tag, so it now runs by default. In 4.13 it
  never ran in our scans at all.
- The match got stricter. 4.13 checked a plain substring (`"ad"` inside
  `"posting as @ada"` passed by luck). 4.14 splits both strings into words,
  drops parentheticals, and needs the visible words to appear in the name as a
  contiguous run.

Which axe-core the specs use is the copy `@axe-core/playwright` depends on
(`~4.x.0`), not web's direct `axe-core` devDependency. That one only supplies
types.

**`aria-hidden` does not get text out of this rule.** The visible text comes
from `visibleVirtual(node, false)`, which checks whether text is visible on
screen, not whether assistive tech can see it. A visible text node inside a
button with an `aria-label` fails whatever ARIA it carries. Fixes that work:
move the text out of the control (an empty overlay button beside a display row,
as the status bar does now), make the name contain the visible words, or put the
expansion in brackets: `"DND (Do Not Disturb)"` passes against visible `DND`.

The status bar's `aria-label` has to stay digit-free (`PhoneFrame.test.ts`,
keypad specs), so putting the clock text into the name was never an option
there.
