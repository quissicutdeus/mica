# jsdom keeps Svelte's `inert` as a property

`inert={cond}` in a Svelte 5 template sets `el.inert`, the IDL property, because
the element has one. A browser reflects that to the `inert` attribute; jsdom
does not. So in a unit test `el.hasAttribute('inert')` reads `false` on a box
that is inert, and the assertion fails for a reason that has nothing to do with
the code under test.

Read `el.inert === true || el.hasAttribute('inert')`. Playwright specs, in a
real Chromium, can keep using `[inert]` and `toHaveAttribute('inert', '')`.

Found on MICA-363 (`web/src/shell/Shell.home.test.ts`, the `isInert` helper).
