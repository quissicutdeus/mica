# Writing a gPhone app

The five-minute version. [`AGENTS.md` §11](../AGENTS.md) is the long one and stays the
authority — this links into it rather than repeating it, because two copies of the same
instructions drift and only one of them gets updated.

## Start it

```sh
pnpm new:app journal            # the app
pnpm new:app journal --service  # and its server half, if it owns a table
```

That writes `web/src/apps/journal/` with three files. Nothing registers them —
`shell/state/registry.ts` finds apps with `import.meta.glob`, so creating the directory
_is_ the installation step.

```
web/src/apps/journal/
├── manifest.ts     what the launcher and the Store know about it
├── index.svelte    the app
└── Icon.svelte     32×32, sized h-8 w-8 like every other icon
```

## See it

```sh
pnpm dev
```

Then `http://localhost:5173/?app=journal` boots straight into your app. The query
parameter is dev-only — it is not merely inert in a production build, it is absent from
the bundle.

## The manifest

```ts
import Icon from './Icon.svelte';
import { defineApp } from '@gphone/sdk';

export default defineApp({
  id: 'journal',
  color: 'bg-emerald-600',
  icon: Icon,
  description: 'Keep a diary',
  permissions: ['storage'],
  core: false
});
```

`core` is required and `defineApp` throws without it. `false` is what you want almost always: an
add-on, kept out of the launcher, offered by the Store, uninstallable. `true` is for something that
ships with the phone and must not be removable. It is stated rather than inferred because it used
to be derived from `author` — a display string — which meant naming yourself "gPhone" silently made
your app permanent.

`id` is the only name that matters. It is lower_snake_case and it is a **key**, not a
label: the directory name, the `gphone:journal:` storage namespace, the `<app>` segment of
every net event, the keybind claim, and the `?app=` link. Renaming it is a data migration,
so pick it once.

The display name is derived from it — `journal` becomes "Journal", `crypto_tracker`
becomes "Crypto Tracker". Pass `name` explicitly only when the id cannot express it
("GPS"). Keep it under about eight characters or it truncates under the icon; that is why
"Administration" is called "Admin".

`color` is a Tailwind **class**, not a color. It is interpolated into a `class` attribute,
so a hex string renders an icon with no background at all. `defineApp` warns about that in
dev, along with a capitalised id and an id another app has already claimed.

## The app

```svelte
<script lang="ts">
  import { Screen, useAppLevels, type AppProps } from '@gphone/sdk';

  let { onback }: AppProps = $props();

  const app = useAppLevels({
    appId: 'journal',
    title: 'Journal',
    onback: () => onback(),
    levels: []
  });
</script>

<Screen title={app.title} onback={app.back}>...</Screen>
```

Two things that look like noise and are not:

- `let { onback }: AppProps = $props()` — the annotation, not `$props<AppProps>()`. The
  generic form only ever worked by a `svelte2tsx` quirk that inlines an object literal.
- `onback: () => onback()` — the closure. `useAppLevels` reads the value once at init, so
  passing the prop by reference freezes whatever it was then.

## The rules that are enforced, not suggested

A test fails if you break these, so you will find out at `pnpm verify` rather than in game:

| Rule                                                   | Enforced by                           |
| ------------------------------------------------------ | ------------------------------------- |
| Import from `@gphone/sdk` and nothing else             | `sdk/boundary.test.ts`                |
| Accept `AppProps`; every app is checked against it     | `sdk/appContract.test.ts`             |
| Ship `preload` if you ship a `badgeStore`              | `sdk/appContract.test.ts`             |
| No new opacity modifiers, no `:has()`, no `@container` | `sdk/cef.test.ts`                     |
| Every `fetchNui` action has a route                    | `server/__tests__/routes.test.ts`     |
| Net events read `gphone:<side>:<app>:<action>`         | `server/__tests__/eventNames.test.ts` |

The first two exist because an add-on installed through the Store resolves `@gphone/sdk`
and nothing else — every relative import out of an app is something a third-party app
cannot do.

## Loading data

Use `onAppForeground`, never `onMount` and never an `$effect`. Apps stay resident and are
merely hidden, so mount runs once per session and an app that fetched there would show
whatever was true when it was first opened. If a badge has to be right _before_ the
launcher draws, declare `preload` in the manifest — `onAppForeground` is too late by
definition.

## Testing it

```ts
import { renderApp } from '@gphone/sdk/testing';

const { findByText, onback } = renderApp(Journal, { id: 'journal' });
```

`renderApp` sets the foreground transition — without it `onAppForeground` never fires and
your app silently never fetches — and supplies `onback` as a spy. It cannot mock
`fetchNui` for you (`vi.mock` is hoisted to the top of the test file) or reset your
module-scoped stores between tests.

## Where to read further

Everything below is in [`AGENTS.md`](../AGENTS.md); the section numbers are stable.

- **§6** — the CEF baseline. FiveM's release CEF is Chromium 103 and Tailwind 4 targets 111. Read it before touching CSS.
- **§10** — `defineService`, which derives the repository, the write allowlist, the CRUD
  events and the DDL from one declaration.
- **§11** — adding an app, in full: the service, the route, the store, the mock registry.
- **§2** — the hard constraints. Worth reading once even if you never write an agent.
