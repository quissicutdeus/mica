# `securitypolicyviolation` in the add-on sandbox: what the event tells a spec

From MICA-202, while adding the https image-beacon refusal to
`web/e2e/addon-sandbox.spec.ts`, and corrected in MICA-442 from what both
browsers actually reported.

- `effectiveDirective` cannot tell two `<img>` beacons apart — an http and an
  https one both report `img-src`. Record `blockedURI` beside it.
- `blockedURI` carries the **full URL, path and query included**. MICA-442
  observed `img-src=http://evil.invalid/beacon?stolen=1` and
  `script-src-elem=https://evil.invalid/payload.js?stolen=1` in both the
  `chromium` and `cef-floor` (Chromium 103) projects. This note used to say it
  was stripped to the origin; it is not, at least for these loads, none of which
  redirected. A substring assertion on the origin
  (`img-src=https://evil.invalid`) still passes, which is why the old claim went
  unnoticed — but do not write an exact match that assumes the path is gone.
- A load from `import()` or an appended `<link rel=stylesheet>` (an appended
  `<script src>` was not tested) reports the element sub-directive,
  `script-src-elem` / `style-src-elem`, in both projects, even though the policy
  declares only `script-src` / `style-src` (the fallback that actually refused
  it).
- A refused `import()` and an unreachable host reject with the same `TypeError`;
  only the violation event tells them apart. Catch the rejection so the probe
  never ends on an unhandled one.
- Chromium also logs every frame CSP refusal as a page-level console error ("…
  violates the following Content Security Policy directive …"), so
  `page.on('console')` sees refusals from inside the sandboxed frame. MICA-442
  confirmed this from a failing run's trace before relying on it.
- `'self'` in the frame's CSP matches nothing, because the frame's origin is
  opaque. Admitting the phone's own origin would have to be spelled out from
  `location.origin` in `AddOnFrame.svelte`; nothing in-tree needed it.
- Chromium has never shipped `navigate-to`; self-navigation is caught by the
  host counting `load` events, not by CSP. The event itself and every directive
  the sandbox uses are CSP Level 2, in Chromium since well before 103.
