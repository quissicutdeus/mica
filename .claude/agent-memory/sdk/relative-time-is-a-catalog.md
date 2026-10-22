# Relative time is a catalog, not Intl

MICA-412 moved `formatRelativeTime` onto the `ui` catalog (`ui.justNow`,
`ui.minutesAgo`, `ui.hoursAgo`, `ui.yesterday`) rather than
`Intl.RelativeTimeFormat`. Checked on 2026-10-22: narrow English is `5 min. ago`
in Chromium 103 (`~/.cache/mica/chromium-103`, `--dump-dom`) and `5m ago` under
Node's ICU 78, so a unit test of Intl output passes in Vitest and draws
differently in game.

Two things that are easy to miss:

- **A bare call does not re-render on a locale switch.** Every formatter reads
  `get(locale)` when it runs. `formatRelativeTime(at, $t)` makes the template
  expression depend on `$t`, which is the re-render path offered to callers.
- **Editing `sdk/ui/locales/*.json` dirties root `locales/{en,de}/ui.json`**,
  which `pnpm generate:locales` writes and the `locales` gate checks. That
  directory is outside the sdk fence, so name it for the lead rather than
  leaving the gate red.

**Why:** the dev browser and Vitest both run a newer ICU than CEF.

**How to apply:** any SDK string that `Intl` could produce in narrow or short
style: prefer the catalog, or verify the Chromium 103 output first.
