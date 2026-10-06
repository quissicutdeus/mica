# MICA-311 dev add-on spec: how it is built, and what bit

`web/e2e/dev-addon.spec.ts` loads a real add-on through `?addonDev=`. Things
that were not obvious:

- **The fixture is built by the template's own `vite.config.ts`**, in a temp
  copy of `tools/addon-template/` with the fixture laid over `src/` and
  `node_modules` made of links (`support/devAddon.ts`, the way
  `addonTemplate.test.ts` does it). A worker-scoped fixture builds it once per
  worker. The template writes its dev output to `dist-dev/`, not `dist/`;
  `mica-dev.json` is in there.
- **Fixture components are `*.svelte.src` on disk.** `lint:web` types every
  `.svelte` file through a tsconfig that includes nothing under `e2e/`, so a
  real `.svelte` there is a parsing error. The helper strips the `.src` on copy.
- **A boot refusal draws no strip and no `mica-dev-addon-error`.** The strip
  renders inside the dev app's frame, and `appId` is null until a load succeeds.
  A refused boot shows only the toast ("Dev add-on not loaded" plus the reason).
  The error testid appears only on a failed Reload.
- **Search for the app by role, not text.** The empty search state quotes the
  query (`No results for "Dev Probe"`), so a text match on the app name passes
  on "nothing found". Assert a result `button`.
- **The shell's `request` event fires for routed and aborted requests too**, so
  "zero requests to the bad origin" is countable with `page.on('request')` while
  `page.route` answers; the happy path proves the counter sees requests.
- **`dist/web` is shared.** A red run with every test failing at "strip not
  found", that passes on an immediate rerun with unchanged sources, was another
  lane building into `../dist/web` mid-run. Rerun before chasing it.
- **A Reload test must serve a changed bundle.** Counting re-fetches passed
  while the running frame was still the old one (the keyed `AddOnFrame` instance
  never left the DOM and ignores a changed `srcdoc`). Only asserting new content
  from the new bytes caught it.
