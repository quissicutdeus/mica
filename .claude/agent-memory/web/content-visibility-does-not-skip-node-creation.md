# `content-visibility: auto` does not skip creating the nodes

MICA-446 (Contacts, about 100 `ListItem` rows with an `Avatar` each). At 4x CPU
in Chromium 103, `content-visibility: auto` with `contain-intrinsic-size` on
every row cut the restyled elements from 2205 to 1769 and barely moved the open
(706 to 675 ms). The 400-545 ms long task was Svelte building the rows' DOM,
plus the GC after it, and offscreen rows still get built. Windowing the rows
(spacers above and below, one measured pitch) took the open to about 300 ms.

So the rule: when the trace's long task is mostly `FunctionCall`, `(program)`
and GC, not `UpdateLayoutTree` and `Layout`, render fewer rows. CSS containment
does nothing for that.

Two traps in a hand-rolled window:

- **`bind:clientHeight` and `bind:offsetHeight` need `ResizeObserver`, which
  jsdom lacks.** Every suite that renders the component then throws. Read the
  sizes in an `$effect` after render instead.
- **Focusing a row scrolls it into view at once, but the `scroll` event waits
  for the next frame.** A held Tab key reaches the window's last row and steps
  out of the list. Read `scrollTop` on `focusin` as well as on `scroll`.

Measure the pitch from two sibling rows' `offsetTop`, not
`getBoundingClientRect`. The Display zoom is a `transform` on the frame, and the
rect is scaled by it (73 layout px read as 59).
