# `securitypolicyviolation` in the add-on sandbox: what the event can tell a spec

From MICA-202, while adding the https image-beacon refusal to
`web/e2e/addon-sandbox.spec.ts`.

- `effectiveDirective` cannot tell two `<img>` beacons apart — an http and an
  https one both report `img-src`. Record `blockedURI` beside it.
- `blockedURI` is "stripped for reporting": a cross-origin resource reports its
  **origin only** (`https://evil.invalid`, no path, no query). From a
  `sandbox="allow-scripts"` srcdoc frame the origin is opaque, so _every_
  resource is cross-origin and every `blockedURI` is an origin. Assert on the
  origin, never the path.
- A `data:` URL that is refused reports `blockedURI` as the scheme alone
  (`data`), per the same stripping rule.
- `'self'` in the frame's CSP matches nothing, for the same opaque-origin
  reason. Admitting the phone's own origin would have to be spelled out from
  `location.origin` in `AddOnFrame.svelte`; nothing in-tree needed it.
- Chromium has never shipped `navigate-to`; self-navigation is caught by the
  host counting `load` events, not by CSP. The event itself and every directive
  the sandbox uses are CSP Level 2, in Chromium since well before 103.
