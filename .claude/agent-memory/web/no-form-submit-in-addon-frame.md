# No `<form>` submit in an add-on

A `core: false` add-on runs in `<iframe sandbox="allow-scripts">`, with no
`allow-forms`. Chromium blocks every form submission there, CEF included, so a
`<form onsubmit>` handler never runs: the button does nothing and nothing is
logged. jsdom and the dev browser outside the frame submit happily, so unit
tests pass (MICA-254, Dark Chat's Create/Join; found in e2e).

Do this instead: a `type="button"` with `onclick`, and Enter handled by
`onkeydown` on each input, skipped while `event.isComposing`. Pin the shape in a
component test (`querySelector('form')` is null), because a behavior test alone
passes either way under jsdom.
