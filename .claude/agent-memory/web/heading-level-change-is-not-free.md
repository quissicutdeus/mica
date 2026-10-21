# A heading level change is invisible only with a size class

`sdk/app-reset.css` zeroes heading **margins** and nothing else. The
`font-size: 100%; font-weight: inherit` rule just below it is for form controls
(`button, input, select, textarea`), not headings. So an `h3` → `h2` swap keeps
the UA's per-level font-size (h2 1.5em, h3 1.17em, h4 1em) unless the element
carries its own size utility (`text-lg`, `text-body-small`, ...). The UA makes
h1–h4 bold, so weight does not shift.

Found on MICA-409, fixing axe `heading-order`. I first told a teammate the reset
covered headings, and had to correct it.

**How to apply:** before changing a heading's level for axe, check that the
element has a `text-*` size class. If it has none, add the one that matches its
current rendered size, or it will grow or shrink. `.prose` in
`app-utilities.css` styles `h1`–`h3` by tag, but only inside rendered markdown.

axe 4.14 `heading-order` fails only a step **down** by more than one level from
the heading before it in DOM order. An overlay rendered after `Screen`'s content
can always take `h2`, whatever the content holds.
