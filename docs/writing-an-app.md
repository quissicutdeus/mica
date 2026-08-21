# Writing a gPhone app

The five-minute version, followed by the rest of what "adding an app" involves.
[`AGENTS.md`](../AGENTS.md) keeps only the rules that apply every session; this is the
authority for everything else about building one, so it doesn't get re-read on every turn.

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

Declare what you use — an undeclared hook now crashes your app with `AppPermissionError`;
`renderApp(App, { permissions: [] })` is how to see it in a test. `pnpm test:unit:web` tells you
exactly which names are missing; the full list is `AppPermission` in `sdk/manifest.ts`.

`core` is required and `defineApp` throws without it. `false` is what you want almost always: an
add-on, kept out of the launcher, offered by the Store, uninstallable. `true` is for something that
ships with the phone and must not be removable. It is stated rather than inferred because it used
to be derived from `author` — a display string — which meant naming yourself "gPhone" silently made
your app permanent.

`id` is the only name that matters. It is lower_snake_case and it is a **key**, not a
label: the directory name, the `gphone:journal:` storage namespace, the `<app>` segment of
every net event, the keybind claim, and the `?app=` link. Renaming it is a data migration,
so pick it once.

The display name is derived from it — `journal` becomes "Journal", `police_scanner`
becomes "Police Scanner". Pass `name` explicitly only when the id cannot express it
("GPS"). Keep it under about eight characters or it truncates under the icon; that is why
"Administration" is called "Admin".

`color` is a utility **class** from `web/src/app-utilities.css` (e.g. `bg-blue-500`), not a color.
It is interpolated into a `class` attribute, so a hex string renders an icon with no background at
all. `defineApp` warns about that in dev, along with a capitalised id and an id another app has
already claimed.

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

## If your app has a server half

The hooks above — `useNotes`, `useContacts` — are core code, and so are the rows in
`shared/routes.ts` behind them. You cannot add to either: they ship inside gPhone, and your
app does not. `useService` is the door that does not require it. The id must be your own app id or `<id>_something` — `permissions.test.ts` refuses anything else, because a service you can name is a service you can read.

```ts
const journal = useService('journal');
const entries = await journal.call<Entry[]>('get', {}, []);
await journal.call('create', { title, body });
```

For a list, `createCrudStore` with `service` set gives you ordering, a `loaded` flag and the
rule that the list follows the server rather than guessing ahead of it:

```ts
// apps/journal/store.ts — built on first use, see the warning below
const build = () =>
  createCrudStore<Entry, Omit<Entry, 'id' | 'citizenid'>>(
    'Journal',
    { list: 'get', create: 'create', update: 'update', remove: 'delete' },
    { service: 'journal', sort: byNewest<Entry>('updated_at') }
  );
```

**Do not call the factory at module scope.** It runs whenever anything imports the file, and if
that happens while the `@gphone/sdk` barrel is still initialising you get `undefined` back — the
symptom is `byNewest is not a function` on a line that plainly imports it. Build it on first use.
A manifest is the usual trigger, because the registry loads every manifest eagerly, so use
`preload: () => import('./store').then((m) => m.entries.load())` rather than importing at the top.

`web/src/apps/notes/store.ts` is the worked example.

Two things this does not give you. The browser mock registry is core too, so `pnpm dev` cannot
stand in for your server — run against a real one. And there is no state helper beyond the store
factory: your app holds its own state in its own module.

## Testing it

```ts
import { renderApp } from '@gphone/sdk/testing';

const { findByText, onback } = renderApp(Journal, { id: 'journal' });
```

`renderApp` sets the foreground transition — without it `onAppForeground` never fires and
your app silently never fetches — and supplies `onback` as a spy. It cannot mock
`fetchNui` for you (`vi.mock` is hoisted to the top of the test file) or reset your
module-scoped stores between tests.

## `core: true` vs `core: false`, and why it forks almost everything below

`core: true` ships with the phone and cannot be uninstalled; `core: false` is an add-on — kept
out of the launcher, offered by the Store, removable. `defineApp` throws if `core` is absent,
deliberately: it used to be `isSystem`, defaulted from `author`, so a **display string** decided
whether an app could be removed, and naming yourself `'gPhone'` was enough to make one permanent.
The derivation was also circular, and the Store grew a second, subtly different copy of it — so
the registry and the uninstall button could disagree, and the button threw. Read `manifest.core`
and nothing else. A remote app is never core: `defineApp` forces `false` when `isRemote` is set
and throws on an explicit `core: true` beside it.

Blabber is the first app that is genuinely `core: false` — the add-on path's first real consumer,
and the Store's first genuine listing rather than a manifest with nothing behind it. The Store's
catalog must never again carry an installable manifest with no code behind it: an unbuilt app
belongs in a document, because an idea recorded in prose is honest and the same idea rendered as
an Install button is not.

The fork shows up in three places:

**The route.** Every **named** NUI action needs a `route()` entry in `shared/routes.ts`.
`client/services/Relay.ts` registers all of them, so there is no per-app client file to write.
**An add-on needs no row here, and cannot add one** — `shared/routes.ts` ships inside gPhone, so
a `core: false` app reaches its service through the one generic route instead —
`useService(id).call(action, data)`, relayed by the single `svc` callback to
`gphone:server:<id>:<action>`. Notes and Blabber are the two worked examples and neither appears
in the table. Reach for a named route only when the app is `core: true`.

This is the layer that goes missing most often. `readConversation`, `renameConversation`,
`archiveConversation`, `rejectCall`, `flipCamera` and all four mail actions have each shipped as
a silent no-op. `server/__tests__/routes.test.ts` cross-references the table against the
`fetchNui` calls in `web/`, the events the server registers, and the browser mock — a missing
layer fails there rather than in game.

**The store.** A core app puts its `createCrudStore` in `web/src/services/<name>.ts` and names
its NUI routes (`list: 'getContacts'`, etc.). An add-on puts it in its own directory and passes
`service` instead, so `events` become _server_ action names and no row in `shared/routes.ts` is
needed — see `web/src/apps/notes/store.ts` (the example under "If your app has a server half"
above). That split is not stylistic: `shared/routes.ts` and `web/src/services/` both ship inside
gPhone, so an app installed from the Store cannot add to either. `sdk/coreBoundary.test.ts`
measures how much of each `core: false` app still depends on being first-party.

A paged read gets `createPagedStore` (`web/src/services/createPagedStore.ts`) instead of
`createCrudStore` — it holds the keyset cursor and knows `nextCursor: null` is the end rather than
"ask again". Pair it with `usePagedList`'s `loadOlder`. Do not page a `createCrudStore`: that
factory fetches a whole list and re-sorts it, which is the opposite of a cursor walking backwards
through one. It takes the same `service` option, so an add-on's paged feed goes through the
generic route too — Blabber's `feed` and `followingFeed` are the worked examples.

**The hook.** A core app's hook goes in `web/src/sdk/host/`; an add-on exports its own from its
own directory, beside the store, because `sdk/host/` ships inside gPhone — `apps/notes/store.ts`
exports `useNotes`, `apps/blabber/store.ts` exports `useBlabber`. Either way the store itself is
never reached by path from another app; the hook is the only handle.

## More wiring rules inside the app

- `sort` on `createCrudStore` is what keeps one order however the list changed — the hand-written
  stores this replaced disagreed about append vs. prepend and sorted on load but not after a
  write. `validate` refuses a write before it leaves the phone. Anything that is not
  list/create/update/delete stays a named method on the store, as Mail's `archive` does; do not
  stretch the factory to cover it.
- Wrap a user-initiated write in `useAppAction`'s `run`, which gives you the busy flag, the
  success toast and the error toast together. Written by hand they come apart: Contacts' delete
  once had neither toast, so a refused delete looked exactly like a real one.
- Act on deep-link props with `useDeepLink`. Return `false` while the data it names has not
  arrived and it will ask again; returning `true` consumes the props, which is what makes back
  work.
- Declare internal levels with `useAppLevels`, deepest first, and pass your `appId`. That one
  call supplies `onback`, the header title, **and** the `back` keybind — the shell owns Backspace
  and pre-empts a ladder that was written but never registered, which is how Notes and Contacts
  both shipped sending the player home from a detail view. `appId` is required because the claim
  outlives the app being on screen (AGENTS.md §2); without it Back reaches whichever app
  registered last.
- Filter a list with `filterByQuery`, and use the shared primitives — `SegmentedControl` for
  tabs, `ToggleSwitch` for a setting, `Skeleton` while a fetch is in flight.
- Page a long list with `usePagedList`. Set `olderAt: 'start'` for a chat, where older rows are
  above and revealing them must not move the reader, and `'end'` for a feed, where they are below
  and it cannot. Use its `offset` for anything positional — a divider, a highlight — because the
  index inside the window is not the index in the list.
- Show `Skeleton` until the store's `loaded` says the first fetch has come back, and only then
  the `EmptyState`. An empty list is not the same statement as "you have nothing"; every list in
  the phone used to make the second one while still waiting for the first.

## The browser mock

Add your app's fixtures to `web/src/nui/mocks/registry.ts`. Without a mock the app is dead in
`pnpm dev` and in Playwright, and — worse — a mock that returns plausible data while doing
nothing makes an e2e test pass with the feature broken.

`defineMockCrud(fixtures, events, options)` covers the CRUD half and mutates the fixtures for
you, which is the part that kept being forgotten: a created note used to vanish on reload while
photos and mail behaved. Say whether the server deletes `'hard'` or `'soft'` — matching it
matters, because a mock that disagrees with the server is a bug you cannot see in the browser.

## Before you call it done

`pnpm verify`. It runs format, typecheck, unit, e2e, build and the dead-code scan in that
order — cheapest first — and prints a per-gate summary naming every gate that failed and every
gate that did not run. CI runs the same command, so the two cannot drift.

`--quick` skips e2e, and only e2e. Do not finish on it: e2e is the only step that catches a
stale mock or a gesture that stopped working. `--bail` stops at the first failure for a tight
edit loop; the default keeps going so a late gate is never hidden behind an early one.

**Keep `pnpm dev` running while you work.** Playwright reuses a server that is already up; when
it has to start its own, the suite takes about two and a half minutes instead of twenty-seven
seconds. `pnpm verify` starts one for you and shuts it down after.

Then run it in game. A green suite is not evidence a NUI feature works — see AGENTS.md §6 and §8.

## Where to read further

- [`schema-and-services.md`](schema-and-services.md) — `defineService` in full: access control,
  keyset paging, membership, child tables, and the identity/accounts model social apps share.
- [`security.md`](security.md) — the full trust model behind AGENTS.md §2's security rules.
- `AGENTS.md` §2 — the hard constraints. Worth reading once even if you never write an agent.
- `AGENTS.md` §6 — the CEF baseline. FiveM's release CEF is Chromium 103. Read it before touching
  CSS.
