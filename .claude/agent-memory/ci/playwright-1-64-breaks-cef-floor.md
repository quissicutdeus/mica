# Playwright 1.64 breaks the cef-floor projects

Found 2026-10-16 bumping `@playwright/test`. 1.64.0 and 1.64.1 call
`element.checkVisibility()` in the injected visibility check with no feature
guard; 1.62.1 and 1.63.0 guard it with `Element.prototype.checkVisibility`. The
`cef-floor*` projects run a real Chromium 103 (`CEF_FLOOR_CHROMIUM`), which
predates `checkVisibility` (Chromium 105), so every locator action there fails
with `element.checkVisibility is not a function`. The other projects pass, so a
run reads as "395 failed" only in the `cef-floor`, `cef-floor-tablet` and
`cef-floor-tablet-light` projects.

**How to apply:** stay on 1.63.x until the floor Chromium is 105 or newer; a
`pnpm update` on the caret range will offer 1.64 again. The CI container tag in
`build-test.yml` (`mcr.microsoft.com/playwright:v<version>-resolute`) has to
move with the lockfile version; the tag list is at
`https://mcr.microsoft.com/v2/playwright/tags/list`.

`pnpm test:e2e:install` prunes the shared `~/.cache/ms-playwright` of browsers
the new version does not use, which removes the Chromium another checkout still
on the old version needs; that checkout must run the install again.
