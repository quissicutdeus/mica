# Writing a gOS app

The five-minute version, followed by the rest of what "adding an app" involves.
[`AGENTS.md`](../AGENTS.md) keeps only the rules that apply every session; this
is the authority for everything else about building one, so it doesn't get
re-read on every turn.

## Start it

**This page assumes you have this repository checked out.** If you do not — if
you are writing a `core: false` add-on for somebody else's server and have no
business in gOS's own tree — start at
[Building an add-on outside this repo](#building-an-add-on-outside-this-repo)
instead, then come back here for everything from [The manifest](#the-manifest)
onwards, which is identical either way.

```sh
pnpm new:app journal            # the app
pnpm new:app journal --service  # and its server half, if it owns a table
```

That writes `web/src/apps/journal/` with three files. Nothing registers them —
`shell/state/registry.ts` finds apps with `import.meta.glob`, so creating the
directory _is_ the installation step.

```text
web/src/apps/journal/
├── manifest.ts     what the launcher and the Store know about it
├── index.svelte    the app
└── Icon.svelte     32×32, sized h-8 w-8 like every other icon
```

## See it

```sh
pnpm dev
```

Then `http://localhost:5173/?app=journal` boots straight into your app. The
query parameter is dev-only — it is not merely inert in a production build, it
is absent from the bundle.

## The manifest

```ts
import Icon from './Icon.svelte';
import { defineApp } from '@gos/sdk';

export default defineApp({
  id: 'journal',
  tile: { bg: 'bg-emerald-600' },
  icon: Icon,
  description: 'Keep a diary',
  permissions: ['storage'],
  core: false
});
```

`tile` is the launcher icon: `bg` is what the tile is painted, `fg` what the
glyph on it inherits. Both are utility classes from `app-utilities.css`, never
colour values — they land in a `class` attribute, and `defineApp` throws on
anything else. Omit `fg` on a dark tile; state it on a light one, or the glyph
inherits a near-white default and comes out illegible. A guard in
`web/src/lib/utilityClasses.test.ts` measures the contrast.

Declare what you use — an undeclared hook crashes your app with
`AppPermissionError`; `renderApp(App, { permissions: [] })` is how to see it in
a test. The full list is `AppPermission` in `sdk/manifest.ts`.

**For a `core: false` add-on, the build derives the list and refuses a manifest
that understates it** (MICA-205). A Vite plugin reads every module that
entered the bundle, maps each name imported from `@gos/sdk` through
`PERMISSION_OF`, and fails the build naming the import and the permission the
manifest lacks. Declaring more than the scan finds is fine. The scanner is
`sdk/lib/permissionScan.ts`; `web/vite.addon.config.ts` runs it for the add-ons
in this repo and `tools/addon-template/vite.config.ts` runs the same one outside
it, so an author without the repo is held to the same rule. The old runtime
check is unchanged: the shell still re-checks every call against what the
manifest declares, so the build is where an honest list is enforced, not the
only place it is checked.

`core` is required and `defineApp` throws without it. `false` is what you want
almost always: an add-on, kept out of the launcher, offered by the Store,
uninstallable. `true` is for something that ships with the phone and must not be
removable. It is stated rather than inferred because it used to be derived from
`author` — a display string — which meant naming yourself "gOS" silently made
your app permanent.

`id` is the only name that matters. It is lower_snake_case and it is a **key**,
not a label: the directory name, the `gos:journal:` storage namespace, the
`<app>` segment of every net event, the keybind claim, and the `?app=` link.
Renaming it is a data migration, so pick it once.

The display name is derived from it — `journal` becomes "Journal",
`police_scanner` becomes "Police Scanner". Pass `name` explicitly only when the
id cannot express it ("GPS"). Keep it under about eight characters or it
truncates under the icon; that is why "Administration" is called "Admin".

`devices` is which frames the app appears on: `['phone']` when absent, which is
what every manifest written before the field existed means, or
`['phone', 'tablet']` for an app that is usable at 1280x800 too. It is a
visibility contract like `requires`: an app whose list omits the device on
screen has no icon on it and `openApp` refuses it. See "Your app on the tablet"
below before listing the tablet.

`color` is a utility **class** from `sdk/app-utilities.css` (e.g.
`bg-blue-500`), not a color. It is interpolated into a `class` attribute, so a
hex string renders an icon with no background at all. `defineApp` warns about
that in dev, along with a capitalised id and an id another app has already
claimed.

## The app

```svelte
<script lang="ts">
  import { Screen, useAppLevels, type AppProps } from '@gos/sdk';

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

- `let { onback }: AppProps = $props()` — the annotation, not
  `$props<AppProps>()`. The generic form only ever worked by a `svelte2tsx`
  quirk that inlines an object literal.
- `onback: () => onback()` — the closure. `useAppLevels` reads the value once at
  init, so passing the prop by reference freezes whatever it was then.

## Your app on the tablet

The shell is one OS drawing one of two devices: the phone at 400x850 and the
tablet at 1280x800 (`shared/devices.ts`). Neither is responsive, and an app is
not asked to be responsive between them either. It is asked to say which it
supports, and to ship a layout for each it names.

Listing `'tablet'` in `devices` says the app is usable in the wide frame. Two
ways to make that true:

- **A second root.** Ship `tablet.svelte` beside `index.svelte` and the shell
  renders it instead, inside the tablet frame, with the same `AppProps` and the
  same hooks. Two panes, list left and detail right, is the shape the reference
  apps take. `pnpm new:app <id> --tablet` scaffolds one, and
  `sdk/appContract.test.ts` holds it to `AppProps` exactly as it holds
  `index.svelte`, and refuses a `tablet.svelte` on an app whose manifest does
  not list the tablet.
- **One root, two layouts.** Read `useDisplay().device` (`'phone'` or
  `'tablet'`) and `useDisplay().frame` (the design size) and branch. This is
  what a `core: false` add-on does today: the sandboxed frame fills whichever
  device is up, and a tablet-specific add-on root is a later ticket.

An app that lists only the phone is simply absent on the tablet: no icon, no
search result, no deep link. Nothing about its server half changes.

## The rules that are enforced, not suggested

A test fails if you break these, so you will find out at `pnpm verify` rather
than in game:

| Rule                                                      | Enforced by                           |
| --------------------------------------------------------- | ------------------------------------- |
| Import from `@gos/sdk` and nothing else                   | `sdk/boundary.test.ts`                |
| Accept `AppProps`; every app is checked against it        | `sdk/appContract.test.ts`             |
| Ship `preload` if you ship a `badgeStore`                 | `sdk/appContract.test.ts`             |
| A `tablet.svelte` belongs to an app that lists the tablet | `sdk/appContract.test.ts`             |
| No new opacity modifiers                                  | `sdk/cef.test.ts`                     |
| No `:has()`, `@container`, or other CSS Chrome 103 lacks  | `pnpm lint:css` (stylelint + doiuse)  |
| Every `fetchNui` action has a route                       | `server/__tests__/routes.test.ts`     |
| Net events read `gos:<side>:<app>:<action>`               | `server/__tests__/eventNames.test.ts` |

The first two exist because an add-on installed through the Store resolves
`@gos/sdk` and nothing else — every relative import out of an app is something a
third-party app cannot do.

## Loading data

Use `onAppForeground`, never `onMount` and never an `$effect`. Apps stay
resident and are merely hidden, so mount runs once per session and an app that
fetched there would show whatever was true when it was first opened. If a badge
has to be right _before_ the launcher draws, declare `preload` in the manifest —
`onAppForeground` is too late by definition.

## Strings

Every label, placeholder, toast and empty state an app shows goes through the
phone's translator (MICA-61), and the app owns its own catalog — an add-on is
not in this repository, so there is no central file it could add to. Register
once at module scope, under your app id, and read with `$t`:

```ts
import { registerMessages, useLocale } from '@gos/sdk';
import en from './locales/en.json';
import de from './locales/de.json';

registerMessages('journal', { en, de });
const { t } = useLocale();
```

```svelte
<EmptyState title={$t('journal.empty')} />
<Button onclick={save}
  >{$busy ? $t('journal.saving') : $t('journal.save')}</Button
>
```

A catalog is a flat object of strings, one entry per key:

```json
{
  "empty": "No entries yet",
  "count.one": "{count} entry",
  "count.other": "{count} entries"
}
```

`{name}` interpolates a param; `plural('journal.count', n)` picks the category
`Intl.PluralRules` says the language needs. A missing key falls back to the
language, then English, then the key itself, and warns once, so a
half-translated locale shows its gaps without breaking the screen. The player
picks the language in Settings > Language, the owner sets a default with the
`gos_locale` convar, and `useLocale().locale` is the active tag if you need it;
`formatDate`, `formatTime` and `formatCurrency` already follow it. An add-on
reads the locale and cannot set it.

`web/src/lib/hardcodedStrings.test.ts` freezes the number of English literals
per `.svelte` file and only lets it fall — a new file must have none. Notes is
the extracted example to copy from.

## If your app has a server half

The hooks above — `useNotes`, `useContacts` — are core code, and so are the rows
in `shared/routes.ts` behind them. You cannot add to either: they ship inside
gOS, and your app does not. `useService` is the door that does not require it.
The id must be your own app id or `<id>_something` — `permissions.test.ts`
refuses anything else, because a service you can name is a service you can read.

```ts
const journal = useService('journal');
const entries = await journal.call<Entry[]>('get', {}, []);
await journal.call('create', { title, body });
```

A custom action on that service declares its input in a contract, in the same
server file that registers it:
`defineContract({ id: 'journal', actions: { … } })` from `@gos/shared/contract`,
with `s.object(…)` from `@gos/shared/schema` or any Standard Schema validator,
linked by `defineService({ contract })`. The server parses the payload before
your handler runs and refuses to start if a registered action has no entry.
`docs/schema-and-services.md` has the worked example.

For a list, `createCrudStore` with `service` set gives you ordering, a `loaded`
flag and the rule that the list follows the server rather than guessing ahead of
it:

```ts
// apps/journal/store.ts — built on first use, see the warning below
const build = () =>
  createCrudStore<Entry, Omit<Entry, 'id' | 'citizenid'>>(
    'Journal',
    { list: 'get', create: 'create', update: 'update', remove: 'delete' },
    { service: 'journal', sort: byNewest<Entry>('updated_at') }
  );
```

**Do not call the factory at module scope.** It runs whenever anything imports
the file, and if that happens while the `@gos/sdk` barrel is still initialising
you get `undefined` back — the symptom is `byNewest is not a function` on a line
that plainly imports it. Build it on first use. A manifest is the usual trigger,
because the registry loads every manifest eagerly, so use
`preload: () => import('./store').then((m) => m.entries.load())` rather than
importing at the top.

`web/src/apps/notes/store.ts` is the worked example.

Two things this does not give you. The browser mock registry is core too, so
`pnpm dev` cannot stand in for your server — run against a real one. And there
is no state helper beyond the store factory: your app holds its own state in its
own module.

## Testing it

```ts
import { renderApp } from '@gos/sdk/testing';

const { findByText, onback } = renderApp(Journal, { id: 'journal' });
```

`renderApp` sets the foreground transition — without it `onAppForeground` never
fires and your app silently never fetches — and supplies `onback` as a spy. It
cannot mock `fetchNui` for you (`vi.mock` is hoisted to the top of the test
file) or reset your module-scoped stores between tests.

## `core: true` vs `core: false`, and why it forks almost everything below

`core: true` ships with the phone and cannot be uninstalled; `core: false` is an
add-on — kept out of the launcher, offered by the Store, removable. `defineApp`
throws if `core` is absent, deliberately: it used to be `isSystem`, defaulted
from `author`, so a **display string** decided whether an app could be removed,
and naming yourself `'gOS'` was enough to make one permanent. The derivation was
also circular, and the Store grew a second, subtly different copy of it — so the
registry and the uninstall button could disagree, and the button threw. Read
`manifest.core` and nothing else. A remote app is never core: `defineApp` forces
`false` when `isRemote` is set and throws on an explicit `core: true` beside it.

Blabber is the first app that is genuinely `core: false` — the add-on path's
first real consumer, and the Store's first genuine listing rather than a
manifest with nothing behind it. The Store's catalog must never again carry an
installable manifest with no code behind it: an unbuilt app belongs in a
document, because an idea recorded in prose is honest and the same idea rendered
as an Install button is not.

The fork shows up in three places:

**The route.** Every **named** NUI action needs a `route()` entry in
`shared/routes.ts`. `client/services/Relay.ts` registers all of them, so there
is no per-app client file to write. **An add-on needs no row here, and cannot
add one** — `shared/routes.ts` ships inside gOS, so a `core: false` app reaches
its service through the one generic route instead —
`useService(id).call(action, data)`, relayed by the single `svc` callback to
`gos:server:<id>:<action>`. Notes and Blabber are the two worked examples and
neither appears in the table. Reach for a named route only when the app is
`core: true`.

This is the layer that goes missing most often. `readConversation`,
`renameConversation`, `archiveConversation`, `rejectCall`, `flipCamera` and all
four mail actions have each shipped as a silent no-op.
`server/__tests__/routes.test.ts` cross-references the table against the
`fetchNui` calls in `web/`, the events the server registers, and the browser
mock — a missing layer fails there rather than in game.

**The store.** A core app puts its `createCrudStore` in
`web/src/services/<name>.ts` and names its NUI routes (`list: 'getContacts'`,
etc.). An add-on puts it in its own directory and passes `service` instead, so
`events` become _server_ action names and no row in `shared/routes.ts` is needed
— see `web/src/apps/notes/store.ts` (the example under "If your app has a server
half" above). That split is not stylistic: `shared/routes.ts` and
`web/src/services/` both ship inside gOS, so an app installed from the Store
cannot add to either. `sdk/coreBoundary.test.ts` measures how much of each
`core: false` app still depends on being first-party.

A paged read gets `createPagedStore` (`web/src/services/createPagedStore.ts`)
instead of `createCrudStore` — it holds the keyset cursor and knows
`nextCursor: null` is the end rather than "ask again". Pair it with
`usePagedList`'s `loadOlder`. Do not page a `createCrudStore`: that factory
fetches a whole list and re-sorts it, which is the opposite of a cursor walking
backwards through one. It takes the same `service` option, so an add-on's paged
feed goes through the generic route too — Blabber's `feed` and `followingFeed`
are the worked examples.

**The hook.** A core app's hook goes in `sdk/host/`; an add-on exports its own
from its own directory, beside the store, because `sdk/host/` ships inside gOS —
`apps/notes/store.ts` exports `useNotes`, `apps/blabber/store.ts` exports
`useBlabber`. Either way the store itself is never reached by path from another
app; the hook is the only handle.

### Your app runs in a frame

If `core: false`, your compiled bundle does not run in the shell's window — it
boots inside a sandboxed `<iframe sandbox="allow-scripts" srcdoc>` with an
opaque origin. Practically:

- Nothing on `window.parent` is reachable except `postMessage` — no shell DOM,
  no shell `localStorage`, no cookies. `allow-same-origin` is not on the
  sandbox, so the origin is opaque and every property access across the wall
  throws; the one channel is the message port the SDK already speaks over for
  you.
- `fetchNui` does not exist in the bundle. All host access goes through
  `@gos/sdk` hooks, which route over `postMessage` to the shell; `useService` is
  the only way to reach your own server actions.
- Storage reads (`useStorage`) are synchronous against a cache the shell
  hydrates in at boot. Data stores (`useContacts`, `useMail`, …) arrive
  asynchronously after your first paint — render an empty/loading state rather
  than assuming a store is populated on mount.
- Those service stores are **read-only** through the wall. `$contactsStore`,
  `$mailStore` and the rest are a feed of what the shell holds; assigning to one
  changes nothing outside your frame and is silently discarded on the next push.
  Call the facet's own functions to write — `useContacts().addContact(...)`,
  `useMail().archiveMail(...)` — and the updated store comes back to you.
- An uncaught error or unhandled rejection inside the frame shows the shell's
  crash screen (the message is visible in DEV) instead of taking down the shell.
- `pnpm --filter web build:addons` builds your app's self-contained bundle to
  `web/public/addons/<id>.js` — check it after changes that touch imports;
  anything that pulls in a relative import out of `web/src/` or references
  `shell/state` will fail in that bundle. `pnpm dev` runs the same bundle (its
  `addons` half is `build-addons.mjs --watch`) and serves it in the same frame,
  so a break shows up there too — but only once the watch rebuild lands, so read
  its output rather than the shell's.

### Building an add-on outside this repo

MICA-175. Everything above assumes `web/src/apps/<id>/` and
`pnpm --filter web build:addons`, which both need a clone. An add-on author has
no reason to have one, so `tools/addon-template/` is a standalone project that
emits the same bundle from anywhere:

```sh
pnpm dlx degit quissicutdeus/gos/tools/addon-template my-addon
cd my-addon
pnpm install
pnpm build          # -> dist/<id>.js
pnpm check          # svelte-check, optional and not run by the build
```

`degit` lifts the subdirectory out of GitHub's repository tarball — no clone, no
`.git`. The template's own `README.md` is the reference; the parts that are
decisions rather than instructions are below.

**Two packages, neither published.** An add-on's imports resolve `@gos/sdk`
_and_ `@gos/shared` (the SDK re-exports from it, so its names are inside the
SDK's own type surface — MICA-186). Both are `private: true` here, both are
consumed as source with no build step, and neither is on npm. The template
installs both as **git dependencies on this repository** with the subdirectory
named by `#path:` — pnpm resolves that through GitHub's codeload tarball rather
than cloning, and pins the resolved commit in the author's lockfile.

That costs four things, none of them hidden, and all four are in the template's
`pnpm-workspace.yaml` and README:

- `@gos/sdk` declares `"@gos/shared": "workspace:*"`, which resolves to nothing
  outside this monorepo — `pnpm install` fails with
  `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND`, talking about a workspace that is not the
  author's. An `overrides` entry redirects that one specifier at the same git
  source, and its ref must match the two dependencies' ref exactly.
- That override is a git dependency reached as a _sub_dependency, which pnpm 11
  refuses by default, so the template sets `blockExoticSubdeps: false`. It is a
  supply-chain guard, it applies project-wide rather than to the one override,
  and switching it off is a real cost rather than a formality.
- Both settings live in `pnpm-workspace.yaml` even for a one-package project:
  **pnpm 11 no longer reads the `pnpm` field in `package.json`.** It warns and
  ignores it, so a `pnpm.overrides` block there looks right, does nothing, and
  leaves you reading the same `workspace:*` error.
- The template names `#dev`, and today it has to: the packaged form of the SDK —
  `sdk/` as a root-level package with an `exports` map (MICA-172) — exists
  only on `dev`. `refs/heads/main` predates it and so does every `v2026.*` tag.
  An author should pin a commit sha as soon as they are past the first build;
  there is no version number worth pinning instead, since the tags are CalVer
  build stamps and `GOS_VERSION` is deliberately empty in an add-on bundle
  (MICA-170 — the constant `1.0.0` some older notes describe is long gone).

**The boundary travels with the template.** `refuseCoreEntry()` in
`web/vite.addon.config.ts` and `sdk/boundary.test.ts`'s scan of `web/src/apps/`
are both in files an out-of-tree author does not have, so the template's own
`vite.config.ts` carries the enforcement: it refuses `@gos/sdk/core` and any
subpath at `resolveId`, and it refuses a manifest that does not say
`core: false` before Vite has finished reading its config. Both fail the build
with the rule in the message. They are conveniences that fail early — the
enforcing boundary is still the sandbox and the shell's own permission re-check
(§7) — but without them the template would be handing out a route to
`useNuiBridge`.

**What it does _not_ carry, and cannot.** `utilityClasses.test.ts` scans
`web/src` only, so an out-of-tree app gets no check that a class it writes
exists in `app-utilities.css` — a token with no rule behind it renders as
nothing, with no error. Neither does anything out there run `cef.test.ts` or
`lint:css`. The template's README states the Chromium 103 rules; enforcing them
is on the author.

**`postcss.config.js` is the one file people will delete.** This repo's add-on
build inherits `web/postcss.config.js` by accident of Vite's config discovery.
Out of tree there is nothing to inherit from, and the consequence is not
cosmetic: `sdk/app-utilities.css` — inlined into every add-on bundle — nests in
about thirty places, and native CSS nesting is Chromium 112. Without that config
the bundle renders correctly in every browser an author can test in and drops
those blocks in game. `web/src/lib/addonTemplate.test.ts` fails this repo's
build if the template loses it, along with every other decision the two configs
have to agree on (`target: 'chrome92'`, `codeSplitting: false`, CSS inlining,
the `__GOS_*__` substitutions).

## More wiring rules inside the app

- `sort` on `createCrudStore` is what keeps one order however the list changed —
  the hand-written stores this replaced disagreed about append vs. prepend and
  sorted on load but not after a write. `validate` refuses a write before it
  leaves the phone. Anything that is not list/create/update/delete stays a named
  method on the store, as Mail's `archive` does; do not stretch the factory to
  cover it.
- Wrap a user-initiated write in `useAppAction`'s `run`, which gives you the
  busy flag, the success toast and the error toast together. Written by hand
  they come apart: Contacts' delete once had neither toast, so a refused delete
  looked exactly like a real one.
- Act on deep-link props with `useDeepLink`. Return `false` while the data it
  names has not arrived and it will ask again; returning `true` consumes the
  props, which is what makes back work.
- Declare internal levels with `useAppLevels`, deepest first, and pass your
  `appId`. That one call supplies `onback`, the header title, **and** the `back`
  keybind — the shell owns Backspace and pre-empts a ladder that was written but
  never registered, which is how Notes and Contacts both shipped sending the
  player home from a detail view. `appId` is required because the claim outlives
  the app being on screen (AGENTS.md §2); without it Back reaches whichever app
  registered last.
- Filter a list with `filterByQuery`, and use the shared primitives —
  `SegmentedControl` for tabs, `ToggleSwitch` for a setting, `Skeleton` while a
  fetch is in flight.
- Page a long list with `usePagedList`. Set `olderAt: 'start'` for a chat, where
  older rows are above and revealing them must not move the reader, and `'end'`
  for a feed, where they are below and it cannot. Use its `offset` for anything
  positional — a divider, a highlight — because the index inside the window is
  not the index in the list.
- Show `Skeleton` until the store's `loaded` says the first fetch has come back,
  and only then the `EmptyState`. An empty list is not the same statement as
  "you have nothing"; every list in the phone used to make the second one while
  still waiting for the first.

## Keyboard shortcuts, and why handlers are a stack

AGENTS.md §2.7 carries the rule: never a raw `keydown` listener or
`<svelte:window on:keydown>` for a phone-level action — declare it in
`shared/keybinds.ts` and claim it with `useKeybinds().onKeybind`. An app that
listens directly cannot be rebound from Settings > Shortcuts and double-fires
against the shell's own handler. An app that genuinely needs raw keys (the
calculator's digits) early-returns on `event.defaultPrevented`.

The part worth understanding rather than memorising is why registration is a
**stack per action rather than a slot**, and why `useAppLevels` insists on an
`appId`.

A mounted app overrides the shell's handler and hands the action back when it
unmounts. As a single slot that fails on the first unmount: the shell's `back`
would be overwritten, then cleared, and Escape would do nothing for the rest of
the session. A stack restores whatever was underneath.

Residency is the second half. Apps are not destroyed when you leave them — they
reuse their component on re-open without re-registering — so a claim outlives
the app being on screen. Without an `appId` the dispatcher would run whichever
app registered last, and reopening Notes after Contacts would run Contacts'
stale `back` handler. So the dispatcher runs only the topmost handler that is
either unscoped or owned by the **foreground** app. Shell handlers pass no id
and are the fallback that is always underneath.

Two scopes, and they rebind in different places. `scope: 'game'` actions rebind
in FiveM's own Key Bindings menu, because the phone holds `SetNuiFocus` and
`RegisterKeyMapping` cannot fire while it does. `scope: 'phone'` actions rebind
in gOS's Shortcuts screen. **Both must refuse to fire while a text field has
focus** — the shell tracks that from `focusin`/`focusout`, since the server
cannot see DOM focus (see [`security.md`](security.md)).

## The browser mock

Add your app's fixtures to `web/src/nui/mocks/registry.ts`. Without a mock the
app is dead in `pnpm dev` and in Playwright, and — worse — a mock that returns
plausible data while doing nothing makes an e2e test pass with the feature
broken.

`defineMockCrud(fixtures, events, options)` covers the CRUD half and mutates the
fixtures for you, which is the part that kept being forgotten: a created note
used to vanish on reload while photos and mail behaved. Say whether the server
deletes `'hard'` or `'soft'` — matching it matters, because a mock that
disagrees with the server is a bug you cannot see in the browser.

## Before you call it done

`pnpm verify`. It runs format, typecheck, unit, e2e, build and the dead-code
scan in that order — cheapest first — and prints a per-gate summary naming every
gate that failed and every gate that did not run. CI runs the same command, so
the two cannot drift.

`--quick` skips e2e, and only e2e. Do not finish on it: e2e is the only step
that catches a stale mock or a gesture that stopped working. `--bail` stops at
the first failure for a tight edit loop; the default keeps going so a late gate
is never hidden behind an early one.

**Keep `pnpm dev` running while you work.** Playwright reuses a server that is
already up; when it has to start its own, the suite takes about two and a half
minutes instead of twenty-seven seconds. `pnpm verify` starts one for you and
shuts it down after.

Then run it in game. A green suite is not evidence a NUI feature works — see
AGENTS.md §6 and §8.

## Licensing what you write

gOS is AGPL-3.0-or-later, and **an add-on built against `@gos/sdk` inherits that
— there is no linking exception.** The add-on build inlines the SDK, its styles
and its supporting code into your bundle, so what you ship contains gOS's code
rather than merely calling it.

For your own server, nothing is asked of you; the licence's obligations attach
to distribution. If you publish an add-on for other servers, publish its source
under the same licence. A closed-source add-on is not something this project's
licensing accommodates.

This is the project's position, not legal advice, and it has not been reviewed
by a lawyer. The README's License section says the same thing at slightly more
length, and [`LICENSE`](../LICENSE) is the text that actually governs.

## Where to read further

- [`schema-and-services.md`](schema-and-services.md) — `defineService` in full:
  access control, keyset paging, membership, child tables, and the
  identity/accounts model social apps share.
- [`security.md`](security.md) — the full trust model behind AGENTS.md §2's
  security rules.
- `AGENTS.md` §2 — the hard constraints. Worth reading once even if you never
  write an agent.
- `AGENTS.md` §6 — the CEF baseline. FiveM's release CEF is Chromium 103. Read
  it before touching CSS.
