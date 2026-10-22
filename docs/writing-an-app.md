# Writing a micaOS app

The five-minute version, followed by the rest of what "adding an app" involves.
[`AGENTS.md`](../AGENTS.md) keeps only the rules that apply every session; this
is the authority for everything else about building one, so it doesn't get
re-read on every turn.

## Start it

**This page assumes you have this repository checked out.** If you do not — if
you are writing a `core: false` add-on for somebody else's server and have no
business in micaOS's own tree — start at
[Building an add-on outside this repo](#building-an-add-on-outside-this-repo)
instead, then come back here for [The manifest](#the-manifest) onwards. Most of
it is the same either way. Four parts are not, and each says so where it
appears: [the rules table](#the-rules-that-are-enforced-not-suggested), whose
tests live in this repository; [the browser mock](#the-browser-mock) and
[testing](#testing-it), which lean on this repository's `web/` tree; and
[Before you call it done](#before-you-call-it-done), which runs this
repository's gates. The template carries its own counterpart to the rules table
and to the browser mock, under the outside-the-repo heading below; testing has
no counterpart there.

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

`--service` adds the server half in Notes' shape: `store.ts` in the app's own
directory on `createCrudStore` from `@mica/sdk`, its browser mock in
`web/src/nui/mocks/services/journal.ts` under scoped keys (`journal:get`), and
`server/services/Journal.ts`. It writes no SDK hook and no `shared/routes.ts`
row, since an add-on can add to neither (MICA-331); see "The store" below.

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
import { defineApp } from '@mica/sdk/app';

export default defineApp({
  id: 'journal',
  tile: { bg: 'bg-emerald-600' },
  icon: Icon,
  description: 'Keep a diary',
  permissions: ['storage'],
  core: false
});
```

A manifest imports `defineApp` from `@mica/sdk/app`, never from `@mica/sdk`. The
shell loads every manifest to build the launcher before the SDK has finished
loading, and the main barrel reaches back into the registry that holds them. A
manifest importing the barrel closes that loop, every binding comes out
`undefined`, and the symptom is `useService is not a function` on a line that
plainly imports it. `@mica/sdk/app` is a leaf — `defineApp`, `lazyBadge` and
nothing that can close a loop — and `sdk/app.ts` has the cycle in full. In this
repository `sdk/boundary.test.ts` refuses a manifest that imports the barrel.
Outside it nothing does, and the template's build does not check, so copy the
import from the template's `src/manifest.ts`.

`tile` is the launcher icon: `bg` is what the tile is painted, `fg` what the
glyph on it inherits. Both are utility classes from `app-utilities.css`, never
colour values — they land in a `class` attribute, and `defineApp` throws on
anything else. Omit `fg` on a dark tile; state it on a light one, or the glyph
inherits a near-white default and comes out illegible. A guard in
`web/src/lib/utilityClasses.test.ts` measures the contrast.

Declare what you use — an undeclared hook crashes your app with
`AppPermissionError`. In this repository `renderApp(App, { permissions: [] })`
is how to see it in a test ([Testing it](#testing-it)); outside it, the
`pnpm dev` demo phone enforces the same check. The full list is `AppPermission`
in `sdk/manifest.ts`.

A `core: false` add-on may only declare a permission that gives it something.
`app-registry-write`, `keybinds-write`, `lock-screen-write`,
`notification-settings-write` and `admin` give an add-on nothing: the shell
answers a sandboxed frame "core only" for every member behind them, so listing
one would put a line on the Store's permission sheet that grants nothing.
`defineApp` throws on a `core: false` manifest that declares one, naming it, in
the add-on's own build and again when the Store installs it. `admin` is refused
outright rather than merely empty: the moderation queue shows who reported whom
and who sits behind a Dark Chat alias, so it is core only whatever a facet row
says (`CORE_ONLY_PERMISSIONS` in `sdk/permissions.ts`), and the shell shuts a
frame whose manifest declares it. Thirteen hooks on the add-on barrel —
`useKeybindsWrite`, `useLockScreenWrite`, `useAppRegistryWrite`, `useMail`,
`useMessages`, `useLocale`, `useAccount`, `useAdmin` and `useReports` among them
— are typed without the members the shell would refuse, so a call that could
never work does not compile. Import one of those hooks anyway and the build's
permission scan says it "is core only" and to stop importing it, rather than
asking you to declare the permission.

**`useAccount` gives no citizenid** (MICA-433). There is no `citizenid` or
`fetchCitizenId` on it for any app, core ones included, and the page never holds
the player's citizenid: it is the character's key in every table, and on ESX it
is the player's licence. `account` still gives the phone number, the balance and
the transactions, and a frame is never sent a `citizenid` or `device_id` key
from anywhere, your own `useService` rows included. Do not build on either being
there.

**For a `core: false` add-on, the build derives the list and refuses a manifest
that understates it** (MICA-205). A Vite plugin reads every module that entered
the bundle, maps each name imported from `@mica/sdk` through `PERMISSION_OF`,
and fails the build naming the import and the permission the manifest lacks.
Declaring more than the scan finds is fine. The scanner is
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
`author` — a display string — which meant naming yourself "micaOS" silently made
your app permanent.

`id` is the only name that matters. It is lower_snake_case and it is a **key**,
not a label: the directory name, the `mica:journal:` storage namespace, the
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

`tile` is required, and `color` is gone (MICA-419). `defineApp` throws on a
manifest that still declares `color`, naming `tile: { bg, fg? }` as the
replacement, because a bundle built against an older SDK can still pass it and
ignoring it would install an app whose author thinks the tile is painted. A `bg`
that is not a single `bg-` class, or an `fg` that is not a `text-` class, throws
too. Where you need the two as one `class` string, call `flattenTile(tile)` from
`@mica/sdk`; it returns `bg` alone when there is no `fg`. An id that is
capitalised or not `lower_snake_case` still only warns, in dev, for a core app.

## The app

```svelte
<script lang="ts">
  import { Screen, useAppLevels, type AppProps } from '@mica/sdk';

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
  `'tablet'`) and `useDisplay().frame` (the design size) and branch.

A `core: false` add-on can take either way. With one root, its sandboxed frame
fills whichever device is up. With a second, the add-on build passes
`tablet.svelte` to `bootAddOn` as `{ tablet }`, and the frame mounts it instead
of `index.svelte` while the tablet is on screen, with the same props and deep
links. The frame learns the device from `useDisplay().device`, so the manifest
must declare the `display` permission; the build refuses a tablet root without
it. Only one root is mounted at a time, so each registers its own `useDeepLink`
and `useSearchProvider` (the manifest declares `search`). Notes is the shipped
example.

An app that lists only the phone is simply absent on the tablet: no icon, no
search result, no deep link. Nothing about its server half changes.

## The rules that are enforced, not suggested

A test fails if you break these, so you will find out at `pnpm verify` rather
than in game:

| Rule                                                      | Enforced by                           |
| --------------------------------------------------------- | ------------------------------------- |
| Import from `@mica/sdk` and nothing else                  | `sdk/boundary.test.ts`                |
| Accept `AppProps`; every app is checked against it        | `sdk/appContract.test.ts`             |
| Ship `preload` if you ship a `badgeStore`                 | `sdk/appContract.test.ts`             |
| A `tablet.svelte` belongs to an app that lists the tablet | `sdk/appContract.test.ts`             |
| No new opacity modifiers                                  | `sdk/cef.test.ts`                     |
| No `:has()`, `@container`, or other CSS Chrome 103 lacks  | `pnpm lint:css` (stylelint + doiuse)  |
| Every `fetchNui` action has a route                       | `server/__tests__/routes.test.ts`     |
| Net events read `mica:<side>:<app>:<action>`              | `server/__tests__/eventNames.test.ts` |

The first two exist because an add-on installed through the Store resolves
`@mica/sdk` and nothing else — every relative import out of an app is something
a third-party app cannot do. The tests run in this repository; an author outside
it is held to the build-time versions the template carries, described under
[Building an add-on outside this repo](#building-an-add-on-outside-this-repo).

## Loading data

Use `onAppForeground`, never `onMount` and never an `$effect`. Apps stay
resident and are merely hidden, so mount runs once per session and an app that
fetched there would show whatever was true when it was first opened. If a badge
has to be right _before_ the launcher draws, declare `preload` in the manifest —
`onAppForeground` is too late by definition.

Anything that keeps running — a poll, a ticking display — should stop when
nobody can see it, and `onAppForeground` cannot tell you that. It fires when the
app comes to the front; putting the phone away does not send the app anywhere,
so nothing fires when the phone goes down. `useAppVisible(appId)` is the other
half: a store that is `true` only while a device is open, its screen is showing
apps (no lock screen or dead battery over it), and your app is the one in front
— phone and tablet alike. Load with `onAppForeground`; start and stop with this.

```ts
const visible = useAppVisible('places');
const { every } = useTimer();

$effect(() => {
  if (!$visible) return;
  void refresh();
  return every(5000, () => void refresh());
});
```

It is implicit — no permission to declare — and an app can only ask about
itself. In a `core: false` add-on it reads `false` until the shell's first
answer arrives, so work gated on it starts a moment late rather than early.

## Strings

Every label, placeholder, toast and empty state an app shows goes through the
phone's translator (MICA-61), and the app owns its own catalog — an add-on is
not in this repository, so there is no central file it could add to. Register
once at module scope, under your app id, and read with `$t`:

```ts
import { registerMessages, useLocale } from '@mica/sdk';
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
`mica_locale` convar, and `useLocale().locale` is the active tag if you need it;
`formatDate`, `formatTime` and `formatCurrency` already follow it. An add-on
reads the locale and cannot set it.

`web/src/lib/hardcodedStrings.test.ts` freezes the number of English literals
per `.svelte` file and only lets it fall — a new file must have none. Notes is
the extracted example to copy from.

## If your app has a server half

**An add-on outside this repo** (`core: false`, from the Store) puts its server
half in its own FiveM resource, registered with `exports.mica:RegisterService`
(MICA-308). Declare the service once with `defineAddonService`, as plain data
with typed fields, and use the same declaration on both sides:

```ts
// src/service.ts
import { defineAddonService, addonOutput } from '@mica/shared/addonService';

export const journal = defineAddonService({
  id: 'journal',
  actions: {
    add: {
      input: { title: { type: 'string', max: 80 } },
      output: addonOutput<{ id: number }>()
    },
    list: { input: {}, output: addonOutput<Entry[]>() }
  }
});

// in the app
const service = useService(journal);
const entries = await service.call('list'); // Entry[], type-checked
await service.call('add', { title }); // a wrong action, field or type fails to compile
```

For a list, `createCrudStore(journal, { list: 'list', create: 'add' })` takes
the same declaration and types its rows from `list`'s output (MICA-313). It asks
a little more of the declaration than `useService` does, because the store keeps
the list in step with the server: `create` must answer the new row (not just its
id, as `add` above does), `update` must take every field of the row, and
`remove` takes `{ id }` alone. Each is a compile error with a message saying
what to declare.

micaOS parses every payload against the declaration and resolves the player
before your resource's handler runs. Push back with `PushToApp` and listen with
`useAppEvents`. The README's "Exports for other resources" has the export
signatures, the field kinds and the limits, and `tools/addon-template/` ships a
working Lua server half that reads the declaration as the JSON its build emits.

**An app in this repo** keeps its server half in `server/services/`, as below.

The hooks above — `useNotes`, `useContacts` — are core code, and so are the rows
in `shared/routes.ts` behind them. You cannot add to either: they ship inside
micaOS, and your app does not. `useService` is the door that does not require
it. The id must be your own app id or `<id>_something` — `permissions.test.ts`
refuses anything else, because a service you can name is a service you can read.

```svelte
<script lang="ts">
  const journal = useService('journal');

  let entries = $state<Entry[]>([]);
  let failed = $state(false);

  async function load() {
    try {
      entries = await journal.call<Entry[]>('get', {});
      failed = false;
    } catch {
      failed = true;
    }
  }
  onAppForeground('journal', () => void load());

  const add = () => journal.call('create', { title, body });
</script>
```

Leave `call`'s third argument, `defaultValue`, off a read like this one. Without
it a failed round trip throws and `failed` lets the screen say the read failed.
With one, the same failure — an error reply, a reply of the wrong shape, a
server half that is not running — resolves to the default instead:
`call<Entry[]>('get', {}, [])` hands back `[]`, which is also what "you have no
entries" looks like. The player whose read was refused is shown an empty diary
and takes it for the truth. MICA-384 took that out of the shipped stores, which
had been reporting a refused first read as "No contacts".

A default is right where it is itself a true answer. Notes' `restoreNote` passes
`{ ok: false }`, and `false` is exactly what a restore that failed means; a
decorative read with a sensible fallback is the other case. A write wants the
error more than a read does, so wrap it in `useAppAction`'s `run` and the
failure reaches the player as a toast.

A custom action on that service declares its input in a contract, in the same
server file that registers it:
`defineContract({ id: 'journal', actions: { … } })` from
`@mica/shared/contract`, with `s.object(…)` from `@mica/shared/schema` or any
Standard Schema validator, linked by `defineService({ contract })`. The server
parses the payload before your handler runs and refuses to start if a registered
action has no entry. `docs/schema-and-services.md` has the worked example.

For a list, `createCrudStore` with `service` set gives you ordering, a `loaded`
flag and the rule that the list follows the server rather than guessing ahead of
it. `loaded` stays `false` until a read has come back with an answer: a load
that failed keeps the last list and leaves `loaded` where it was, and the next
foreground load is the retry.

A failed read also sets the store's `error`, a `Readable<string | null>` holding
the failure's message and cleared by the next read that answers. That is how a
component tells "still loading" from "refused": both leave `loaded` `false` and
the list empty, so `error` is the signal and an empty list never is. `load()`
resolves either way, so nothing needs a `catch` to stay quiet. A server
refusal's message is ready to show; any other failure may read like a log line,
so word the player-facing text yourself. `createPagedStore` has the same
`error`, set by a failed `load` or `loadMore`.

In an add-on, `service` is not optional. A sandboxed frame has no named NUI
actions, so a store built there from a string and without `service` would have
every read and write refused; the factory throws at construction instead, with a
message naming the option. The first argument is only a label for the console,
never the service. Building the store from your `defineAddonService`
declaration, as above, supplies the service for you. The phone's own stores are
unaffected.

```ts
// apps/journal/store.ts
import { createCrudStore, byNewest } from '@mica/sdk';

export const entries = createCrudStore<Entry, Omit<Entry, 'id' | 'citizenid'>>(
  'Journal',
  { list: 'get', create: 'create', update: 'update', remove: 'delete' },
  { service: 'journal', sort: byNewest<Entry>('updated_at') }
);
```

Build the store at module scope, as Notes does. It used to have to be built on
first use: calling the factory at the top level ran it whenever anything
imported the file, and if that happened while the `@mica/sdk` barrel was still
initialising the imports came back `undefined` — `byNewest is not a function`,
on a line that plainly imports it. `@mica/sdk/app` removed the cause. A manifest
now imports a leaf, so importing the barrel no longer drags every app in behind
it, and the lazy construction went with the reason for it.

What still holds is the other half of that rule: **a manifest must not import
the store statically.** The registry loads every manifest eagerly, so a static
import would evaluate the store, and with it the barrel, in the middle of that
load. A manifest reaches the store only through a dynamic import, as in
`preload: () => import('./store').then((m) => m.entries.load())`. Leave
`preload` off unless the data has to be right before the app is opened, such as
a badge on the launcher.

`web/src/apps/notes/store.ts` is the worked example, and its comment holds the
same account.

Two things this does not give you. There is no state helper beyond the store
factory: your app holds its own state in its own module. And the browser mock
registry, `web/src/nui/mocks/`, is core code in this repository's `web/` tree,
so an add-on built outside it cannot add to it. What answers for your server in
the browser depends on where you are building:
[The browser mock](#the-browser-mock) in this repository, and `@mica/sdk/dev`
outside it, under
[Building an add-on outside this repo](#building-an-add-on-outside-this-repo).

## Testing it

**This section is for an app in this repository.** `@mica/sdk/testing` is not a
package export. It is an alias that `web/vite.config.ts` and
`web/tsconfig.app.json` declare for the `web/` Vitest project, pointing at
`web/src/testing.ts`, and `sdk/package.json`'s `exports` leaves it out on
purpose: the helper builds the shell's own in-process host, which is a phone
concern the published SDK cannot carry. In a project outside this repository the
import does not resolve.

```ts
import { renderApp } from '@mica/sdk/testing';

const { findByText, onback } = renderApp(Journal, { id: 'journal' });
```

`renderApp` does four things, in this order, and the first is the one that
matters. It sets `id` as the foreground app — without that transition
`onAppForeground` never fires and your app silently never fetches. It builds the
in-process host for that id, granting every permission unless you pass
`permissions` (`permissions: []` is how a test sees `AppPermissionError`). It
registers that host and hands it to the component through Svelte context. And it
renders with `onback` supplied as a spy, which it returns. It cannot mock
`fetchNui` for you (`vi.mock` is hoisted to the top of the test file) or reset
your module-scoped stores between tests.

**Outside this repository there is no counterpart to `renderApp`.** Steps one to
three are made of things the add-on barrel does not export: the shell's
navigation state, `createInProcessHost` and the context key a component reads
its host from. So there is no supported way to give a component that calls an
SDK hook the host it expects, and a test of such a screen has nothing to stand
on. Two things do work:

- **Logic that never touches a hook** — a formatter, a reducer, the shape of
  your service declaration — is plain TypeScript and needs only a test runner.
- **A component that calls no SDK hook** renders with `@testing-library/svelte`
  directly. This is `renderApp` with the three host steps removed, which is why
  it only suits a component that needs none of them:

  ```ts
  import { render } from '@testing-library/svelte';
  import { vi } from 'vitest';
  import EntryRow from './EntryRow.svelte';

  const onpick = vi.fn();
  const { findByText } = render(EntryRow, { props: { entry, onpick } });
  ```

  The template installs neither Vitest nor `@testing-library/svelte`; add both,
  with a DOM environment and the Svelte Vite plugin the template already uses.

For a whole screen, the supported way to see it work is the demo phone:
`pnpm dev` in the template, with your server half answered by `src/mock.ts`
([Building an add-on outside this repo](#building-an-add-on-outside-this-repo)).
That is a look at it running, not an assertion.

## `core: true` vs `core: false`, and why it forks almost everything below

`core: true` ships with the phone and cannot be uninstalled; `core: false` is an
add-on — kept out of the launcher, offered by the Store, removable. `defineApp`
throws if `core` is absent, deliberately: it used to be `isSystem`, defaulted
from `author`, so a **display string** decided whether an app could be removed,
and naming yourself `'micaOS'` was enough to make one permanent. The derivation
was also circular, and the Store grew a second, subtly different copy of it — so
the registry and the uninstall button could disagree, and the button threw. Read
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
add one** — `shared/routes.ts` ships inside micaOS, so a `core: false` app
reaches its service through the one generic route instead —
`useService(id).call(action, data)`, relayed by the single `svc` callback to
`mica:server:<id>:<action>`. Notes and Blabber are the two worked examples and
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
`web/src/services/` both ship inside micaOS, so an app installed from the Store
cannot add to either. `sdk/coreBoundary.test.ts` measures how much of each
`core: false` app still depends on being first-party.

A paged read gets `createPagedStore` (`sdk/createPagedStore.ts`, exported from
`@mica/sdk` like `createCrudStore`) instead of `createCrudStore` — it holds the
keyset cursor and knows `nextCursor: null` is the end rather than "ask again".
Pair it with `usePagedList`'s `loadOlder`. Do not page a `createCrudStore`: that
factory fetches a whole list and re-sorts it, which is the opposite of a cursor
walking backwards through one. It takes the same `service` option, so an
add-on's paged feed goes through the generic route too — Blabber's `feed` and
`followingFeed` are the worked examples.

**The hook.** A core app's hook goes in `sdk/host/`; an add-on exports its own
from its own directory, beside the store, because `sdk/host/` ships inside
micaOS — `apps/notes/store.ts` exports `useNotes`, `apps/blabber/store.ts`
exports `useBlabber`. Either way the store itself is never reached by path from
another app; the hook is the only handle.

**The theme.** Both kinds read the phone's current scheme through
`useTheme().schemeStore`, and that is what an app theming itself to the phone
needs. Deriving a scheme from some _other_ seed — `buildSchemes`, `cssVarBlock`,
`backgroundForScheme`, with `DEFAULT_SEED`, `sanitizeSeed` and
`seedFromRgbString` beside them — is on `@mica/sdk/core` only (MICA-187). Not
because it is dangerous: `buildSchemes` pulls
`@material/material-color-utilities` into any bundle that can reach it, about 21
kB gzipped, and Rollup does not shake it out of an add-on that never calls it
(MICA-181 measured a snake game gaining 104 kB for nothing). A core app runs
in-process where the shell has already loaded the engine, so it pays nothing; an
add-on cannot resolve `@mica/sdk/core`, so its bundle is unchanged — all four
were rebuilt byte-identical before and after the export. If a real add-on ever
needs its own seed, that cost gets weighed then, on `@mica/sdk`.

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
  `@mica/sdk` hooks, which route over `postMessage` to the shell; `useService`
  is the only way to reach your own server actions.
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
pnpm dlx degit quissicutdeus/mica/tools/addon-template my-addon
cd my-addon
pnpm install
pnpm build          # -> dist/<id>.js
pnpm check          # svelte-check, optional and not run by the build
```

`degit` lifts the subdirectory out of GitHub's repository tarball — no clone, no
`.git`. The template's own `README.md` is the reference; the parts that are
decisions rather than instructions are below.

**Running it in the browser (MICA-311).** `pnpm dev` in the template builds your
add-on on every save and prints a link to the demo phone, which loads the bundle
from `127.0.0.1:5174` into the same sandboxed frame, under the same permission
checks, as an installed add-on. There is no FiveM server behind it, so the
answers for your server half come from a mock that runs inside your own frame.
You write it once, in `src/mock.ts`, with `defineAddonMock` from
`@mica/sdk/dev`:

```ts
// src/mock.ts
import { defineAddonMock } from '@mica/sdk/dev';
import { addonError } from '@mica/shared/addonService';
import { journal } from './service';

const rows: { id: number; title: string }[] = [];

export default defineAddonMock(journal, ({ push }) => ({
  list: () => rows,
  add: (_citizenid, { title }) => {
    if (rows.length >= 50) return addonError('You already have 50 entries.');
    const row = { id: rows.length + 1, title };
    rows.push(row);
    push('added', { id: row.id });
    return row;
  }
}));
```

The handlers take the same arguments as the ones you give
`exports.mica:RegisterService` — the citizen, the parsed input and the source —
so the file reads as a sketch of your Lua server half. You do not call
`installAddonMock` yourself: the template's generated dev entry does, in
development mode only. What the mock keeps from the real path is the part that
surprises people. Input is parsed against your declaration before a handler
runs, and a refusal reaches your UI as it would in game. A handler that throws,
an action the declaration does not name, or an answer that is not JSON gives the
generic failure, with the cause on the console. A failed call rejects, or
resolves to `defaultValue` if you passed one, exactly as above. Answers make the
JSON round trip, so a `Date` arrives as a string. Every call is made as one
fixed dev citizen, and `push(event, payload)` stands in for
`exports.mica:PushToApp` and reaches `useAppEvents`.

What it does not mock is the shell's per-frame rate limit, the server's
per-action limiter and handler timeout, and the 15-second client timeout. A mock
answers as fast as it runs, so a loop that is fine here can still be limited in
game. And it answers only an id the phone would let your app call — your
manifest's `services` if it lists them, otherwise your app id and ids starting
`<id>_` — and throws at install, naming the rule, for any other, since the phone
would refuse every call to it in game.

**`@mica/sdk/dev` must never reach a bundle you ship**, and that is why it is
off both barrels and why the template enforces it. In a bundle a player
installs, the mock would answer your service itself, as a fake citizen, instead
of your server — every write lost and every read invented, with nothing failing.
`pnpm dev` builds into `dist-dev/`, never `dist/`, and `pnpm build` fails on the
import of `@mica/sdk/dev` from anywhere, on the files behind it however they
were reached, and on a finished chunk that still carries the mock's marker
string, which catches a copy of the mock pasted into your own source. An app in
this repository does not use it either: `sdk/boundary.test.ts` refuses the
import, and those apps are answered by [the browser mock](#the-browser-mock).

**Two packages, neither published.** An add-on's imports resolve `@mica/sdk`
_and_ `@mica/shared` (the SDK re-exports from it, so its names are inside the
SDK's own type surface — MICA-186). Both are `private: true` here, both are
consumed as source with no build step, and neither is on npm. The template
installs both as **git dependencies on this repository** with the subdirectory
named by `#path:` — pnpm resolves that through GitHub's codeload tarball rather
than cloning, and pins the resolved commit in the author's lockfile.

That costs four things, none of them hidden, and all four are in the template's
`pnpm-workspace.yaml` and README:

- `@mica/sdk` declares `"@mica/shared": "workspace:*"`, which resolves to
  nothing outside this monorepo — `pnpm install` fails with
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
  `sdk/` as a root-level package with an `exports` map (MICA-172) — exists only
  on `dev`. `refs/heads/main` predates it and so does every `v2026.*` tag. An
  author should pin a commit sha as soon as they are past the first build; there
  is no version number worth pinning instead, since the tags are CalVer build
  stamps and `MICA_VERSION` is deliberately empty in an add-on bundle (MICA-170
  — the constant `1.0.0` some older notes describe is long gone).

**The boundary travels with the template.** `refuseCoreEntry()` in
`web/vite.addon.config.ts` and `sdk/boundary.test.ts`'s scan of `web/src/apps/`
are both in files an out-of-tree author does not have, so the template's own
`vite.config.ts` carries the enforcement: it refuses `@mica/sdk/core` and any
subpath at `resolveId`, and it refuses a manifest that does not say
`core: false` before Vite has finished reading its config. Both fail the build
with the rule in the message. They are conveniences that fail early — the
enforcing boundary is still the sandbox and the shell's own permission re-check
(§7) — but without them the template would be handing out a route to
`useNuiBridge`.

**The checks this repo runs travel with it too (MICA-312).** A utility class
with no rule behind it renders as nothing, with no error, and CSS past Chromium
103 renders in every browser an author can test in and breaks only in game. The
checks that catch both live in `sdk/checks/`, and this repo's
`utilityClasses.test.ts`, `cef.test.ts` and `lint:css` run the same code. The
template's `pnpm check` runs them over the add-on's `src/` after `svelte-check`:
unknown classes, `h-full` or bare `flex-1` inside `Screen`, an opacity modifier
on a themed role token, CSS past the floor (including `color-mix()`, which the
stylelint plugin alone does not flag) and inline styles past it. It prints
`file:line rule message` and exits 1 on any of them, and exits 2, never 0, when
it finds nothing to check or cannot run stylelint. The stylelint half is
published as `@mica/sdk/stylelint`. What it cannot check is a class built at run
time; it lists those as unchecked.

**`postcss.config.js` is the one file people will delete.** This repo's add-on
build inherits `web/postcss.config.js` by accident of Vite's config discovery.
Out of tree there is nothing to inherit from, and the consequence is not
cosmetic: `sdk/app-utilities.css` — inlined into every add-on bundle — nests in
about thirty places, and native CSS nesting is Chromium 112. Without that config
the bundle renders correctly in every browser an author can test in and drops
those blocks in game. `web/src/lib/addonTemplate.test.ts` fails this repo's
build if the template loses it, along with every other decision the two configs
have to agree on (`target: 'chrome92'`, `codeSplitting: false`, CSS inlining,
the `__MICA_*__` substitutions).

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
- Send a notification with `usePhoneNotification(appId)`, passing your own app
  id; it needs the `notifications` permission. A core app that omits the id has
  its notices filed under `system`. An add-on may omit it, because the shell
  pins the id to the add-on's own whatever is passed. `sendNotification` files
  under your app whatever `type` it is given, `toast` carries your own toasts
  only, and `dismissNotification` throws for an id your app did not send.
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
- Drag with `use:pointerDrag={{ onstart, onmove, onend }}`. The phone is drawn
  through a `transform: scale()`, so client-pixel deltas applied 1:1 slide out
  from under the pointer at any Phone Size but 100%; `pointerDrag` hands you
  travel since the press already in the element's own pixels, and captures the
  pointer so the drag survives leaving the element. `measureDragRatio(element)`
  is the correction on its own, for input it does not cover (a wheel zoom around
  the cursor). Put `touch-none select-none` on the element yourself. Places' map
  is the worked example.
- Filter a list with `filterByQuery`, and use the shared primitives —
  `SegmentedControl` for tabs, `ToggleSwitch` for a setting, `Skeleton` while a
  fetch is in flight.
- A social app does not draw its own identity screens. `EditProfile` is the
  display-name and bio panel (the handle is shown, never editable, because a
  rename would break every mention already posted), `ClaimHandle` is the pick-a-
  handle gate, and `AccountMenu` is the dropdown that switches between accounts.
  All three are dialogs that trap focus and leave Back to your `useAppLevels`
  levels. Blabber and Glimpse use them.
- `Avatar` takes a `name` (or an `@handle`) and draws its initials through
  `initialsOf`, which is also exported: two or more words give the first and
  last letter, one word its first, and nothing drawable gives the silhouette.
  The photo is decorative unless you pass `alt`, which you should do only where
  the avatar stands alone; beside a name it would be read twice.
- A relative time that must follow the language is `formatRelativeTime(at, $t)`,
  with `$t` from `useLocale()`. Called bare it reads the locale once and
  re-formats only when something else re-renders it.
- Size an icon with the `size-icon-xs` to `size-icon-xl` classes (0.875rem up to
  2rem; `sm`, `md` and `lg` sit between) rather than an arbitrary width.
- Page a long list with `usePagedList`. Set `olderAt: 'start'` for a chat, where
  older rows are above and revealing them must not move the reader, and `'end'`
  for a feed, where they are below and it cannot. Use its `offset` for anything
  positional — a divider, a highlight — because the index inside the window is
  not the index in the list.
- Show `Skeleton` until the store's `loaded` says the first fetch has come back,
  and only then the `EmptyState`. An empty list is not the same statement as
  "you have nothing"; every list in the phone used to make the second one while
  still waiting for the first. A first read that failed does not set `loaded`,
  in either store factory (MICA-384), so watch the store's `error` beside it:
  show the skeleton while `loaded` is false and `error` is `null`, and the
  failure once `error` is set.

## Being findable from the home search

The drawer's search finds apps, contacts, conversations, photos, mail and
listings because the shell holds all six. It holds nothing your app owns, and
for a `core: false` app it never can: core may not name an app the Store
installs, and your rows live in a sandboxed frame the shell cannot read. So you
answer for them.

**A search provider declares `search`** (MICA-433). The shell hands every
running provider the player's query as they type it, one keystroke at a time,
whether or not they ever opened your app. That used to be implicit, on the
reasoning that being found is only a way into your app; the query is what the
player typed, and reading it is an ask, so the Store's permission sheet now says
so. `useSearchProvider` without `search` throws `AppPermissionError`, and the
build's permission scan names it.

```ts
useSearchProvider('notes', (needle) =>
  filterByQuery($notes, needle, (n) => [n.title, n.content]).map((note) => ({
    id: note.id,
    title: note.title || $t('notes.untitled'),
    subtitle: note.content.replace(/\s+/g, ' ').trim(),
    props: { noteId: note.id }
  }))
);
```

That is Notes, which is the whole of the first implementation and worth copying.
`needle` arrives trimmed and lower-cased and is never empty — an empty query
clears your rows without asking you anything. `id` need only be unique among
your own hits. The call returns a release function for a provider scoped to one
screen; otherwise unmount ends it.

**`props` is a deep link into your app**, the same object `useDeepLink` reads
back, because a tap is `openApp(appId, props)`. A provider is therefore only as
useful as the deep link behind it: omit `props` and the row opens your app root,
which is honest where a dead tap would not be, but it is half a feature. Wire
the deep link first, then the provider.

Three consequences of apps being resident, and they are why this is a hook and
not a manifest field:

- **Your app has to be running.** Apps mount on first open and stay mounted, so
  a phone that has not opened your app this session lists nothing from it. No
  hook can fix that; an app that is not running has no code in memory to ask.
- **Nothing is fetched to answer a search.** `search` is synchronous by
  construction and answers from what you already hold. If your rows should be
  findable before your app is first opened, that is what `preload` in the
  manifest is for.
- **Keep it cheap.** It runs on a keystroke, and in a frame it runs on the other
  side of two messages. A `search` that throws is caught and your app
  contributes nothing for that keystroke, logged once rather than once per
  character, so a bug in yours never breaks the phone's search.

What crosses the seam is only what you returned. The shell publishes the needle,
your frame answers with the hits it chose, and the rows behind them stay where
they are. The app id on that facet is stamped by the host from the frame the
call came from, so a provider can only ever publish under its own name. An
answer for a needle nobody is searching any more is dropped rather than shown,
because a reply for `not` can land after the player has typed `note`. A hit
missing an `id` or a title is dropped too; `props` is handed back to you
untouched and the shell reads none of it.

Two caps, and they are different numbers on purpose. The drawer draws five rows
per group, as it does for every other source. The shell holds up to twenty per
app, so an app that ranks its own hits may publish a few spares, and a frame
that published fifty thousand cannot make the shell keep them. Everything held
is forgotten as soon as nothing is being searched.

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
in micaOS's Shortcuts screen. **Both must refuse to fire while a text field has
focus** — the shell tracks that from `focusin`/`focusout`, since the server
cannot see DOM focus (see [`security.md`](security.md)).

## The browser mock

**This section is for an app in this repository.** An add-on built outside it
cannot add a file to `web/`; its mock is `src/mock.ts`, written with
`defineAddonMock` from `@mica/sdk/dev` (see
[Building an add-on outside this repo](#building-an-add-on-outside-this-repo)).

Add your app's fixtures to a file of its own,
`web/src/nui/mocks/services/<id>.ts`, exporting `mocks`; the registry picks
every file there up, so nothing central is edited (`pnpm new:app <id> --service`
writes it for you). Without a mock the app is dead in `pnpm dev` and in
Playwright, and — worse — a mock that returns plausible data while doing nothing
makes an e2e test pass with the feature broken.

`defineMockCrud(fixtures, events, options)` covers the CRUD half and mutates the
fixtures for you, which is the part that kept being forgotten: a created note
used to vanish on reload while photos and mail behaved. Say whether the server
deletes `'hard'` or `'soft'` — matching it matters, because a mock that
disagrees with the server is a bug you cannot see in the browser.

## Before you call it done

In this repository, `pnpm verify`; outside it, `pnpm check` and `pnpm build` in
the template are the gates. `pnpm verify` runs format, typecheck, unit, e2e,
build and the dead-code scan in that order — cheapest first — and prints a
per-gate summary naming every gate that failed and every gate that did not run.
CI runs the same command, so the two cannot drift.

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

micaOS is AGPL-3.0-or-later, and **an add-on built against `@mica/sdk` inherits
that — there is no linking exception.** The add-on build inlines the SDK, its
styles and its supporting code into your bundle, so what you ship contains
micaOS's code rather than merely calling it.

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
