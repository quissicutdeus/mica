# gPhone

**A modern, open-source custom phone resource for FiveM** —
[Live Demo](https://gphone.site/) · [SDK Docs](https://docs.gphone.site/)

Powered by TypeScript, Svelte 5, Vite, and esbuild.

---

## Overview

**gPhone** is a feature-rich, open-source smartphone resource designed for FiveM
servers. Built from the ground up using modern web technologies and a decoupled
TypeScript architecture, gPhone provides a slick, realistic mobile experience
for players and seamless framework integration for server developers.

---

## Key Features

### 📱 Applications & UI

- **Phone & Dialer**: Full contact dialing, active call management, and custom
  in-game phone prop animations.
- **Contacts**: Contact management with favoriting, custom avatars, and soft
  deletion.
- **Messages**: Individual and group messaging with support for image
  attachments directly linked to the photo gallery.
- **Mail System**: Dedicated email application with full database integration
  and unread status indicators.
- **Banking**: Dynamic bank card generation based on player citizen ID, live
  balance tracking, and transfer handling.
- **Media & Camera**: In-game screenshot/camera integration, automatic image
  compression, gallery view, location sharing, and attachment sharing.
- **Notes**: Full-featured note-taking app with instant saving.
- **Bluetooth Proximity Sharing**: Share a contact or drop a photo to every
  nearby, Bluetooth-visible player — computed server-side from live in-game
  position, no external player list ever reaches the client. Range defaults to
  15 meters, configurable via `gphone_bluetooth_range`. A player turns
  discoverability off in Settings > Network; while off, they are invisible to a
  scan and receive nothing unsolicited.
- **Calculator**: Full mathematical calculator with an optimized touchscreen
  keypad layout.
- **Blabber** _(add-on)_: Short public posts under an `@handle`. Replies,
  **mouths** (a repeat, or a quote when you add your own words), likes,
  `@mention` notifications, and strictly one-to-one direct messages. Follow an
  account and its posts turn up in a Following feed of their own; the counts on
  a profile open the lists behind them. An author can fix a typo for 15 minutes
  — `gphone_blabber_edit_window` — and then the post freezes. A player may hold
  several accounts and switch between them, and the owning `citizenid` never
  reaches another reader, so alts stay uncorrelated. Not on the home screen out
  of the box: it is the first genuinely non-core app and installs from the
  Store.
- **Marketplace**: Peer-to-peer classified listings — a feed with debounced
  search, a detail screen that can Call, Text or Report the seller, a create
  form capped at four photos, and a My Listings screen to mark sold or remove.
  Ships with the phone.
- **Hodlr** _(add-on)_: Trade **gCoin**, the one simulated coin. A single global
  price the server walks every 30 seconds within a $50–$5000 band, a 24-hour
  chart, and buy/sell settling against the player's bank balance. Both trades
  are atomic conditional SQL, so two concurrent taps cannot double-spend or lose
  an update.
- **Snek** _(add-on)_: The phone's game, with a leaderboard on the shared
  `highscores` service.
- **Store Application**: Built-in app marketplace to browse, install, and manage
  community add-on apps. Features Installed tab sorting (`newest`, `oldest`,
  `updated`, `name`), installation date metrics (`installedAt`, `updatedAt`), a
  permissions inspector — enforced by the host rather than documented — and app
  storage footprint metrics.
- **Admin**: Review and moderate player reports. Hidden from the home screen for
  anyone without an admin ace; the server gates the queue and every moderation
  action independently of what the UI shows.
- **Settings & Status**: Settings application with an **About** section (phone
  number, OS version, first boot timestamp, and smart git build/commit info),
  24-hour time toggles, embedded Developer Tools, dynamic battery drain
  lifecycle, and hardware controls.
- **Home Screen Edit Mode**: Right-click icon gesture to trigger Edit Mode,
  swapping unread notification badges for gray minus action buttons on removable
  add-on apps with automatic Edit Mode exit when no add-on apps remain.
- **Home Screen Layout**: Drag-and-drop icon arrangement across the grid, a
  pinned dock, a slide-up app drawer, and a first-run hint for the (empty by
  default) home screen.
- **Search**: One live search from the home screen across apps, contacts and
  messages.

### 🛠️ Backend & Core Architecture

- **SDK-First Architecture (`@gphone/sdk`)**: OS hooks for data (`useContacts`,
  `useMedia`, `useMail`, `useMessages`, `useAccount`/`useAccounts`, `useCall`,
  `useReports`/`useReport`, `useMarketplace`, `useHighscores`,
  `useNotifications`), for the device (`useSystemHardware`, `useClock`,
  `useDisplay`, `useCamera`, `useSound`, `useKeybinds`, `useLocation`), and for
  the app itself (`useNavigation`, `useAppLevels`, `useAppAction`, `useStorage`,
  `usePersisted`, `useTimer`, `useDeepLink`, `usePagedList`,
  `usePhoneNotification`, `useAppRegistry`, `useAppEvents`, `useTheme`,
  `useWallpaper`, `useNotificationSettings`, `useAdmin`, `useDevTools`,
  `useService`). Plus `AppProps` — the one boundary every app crosses, and
  typechecked. Apps import the SDK and nothing else, enforced by a test rather
  than documented and hoped for. A `core: false` add-on runs the SDK inside a
  sandboxed `<iframe sandbox="allow-scripts" srcdoc>`, opaque-origin and talking
  to the shell only over `postMessage`.
- **Written for app authors**: `pnpm new:app <id>` scaffolds a working app,
  `localhost:5173/?app=<id>` boots straight into one, and `renderApp` from
  `@gphone/sdk/testing` unit-tests one. See
  [docs/writing-an-app.md](docs/writing-an-app.md).
- **Client & NUI Transport Safety**: Deterministic ID generation and 15-second
  safety timeouts (`ClientApp.ts`) preventing NUI callbacks from hanging CEF
  indefinitely.
- **Core vs. Add-on Protection Engine**: Every manifest declares `core`
  explicitly — `true` ships with the phone and cannot be uninstalled, `false` is
  a Store-managed add-on. Stated rather than inferred, because it was once
  derived from the app's `author` string, which made a display value decide
  whether an app could be removed. A remote bundle is never core.
- **App Isolation & Guardrails**: Wrapped dynamic app rendering with Svelte 5
  `<svelte:boundary>` (`ErrorBoundary.svelte`) preventing third-party app
  runtime exceptions from locking FiveM NUI mouse focus or breaking OS
  navigation.
- **Dual-Runtime Transport Abstraction**: Pluggable `ITransportAdapter` layer
  (`NuiTransportAdapter`, `MockTransportAdapter`, `WebSocketTransportAdapter`)
  cleanly separating FiveM CEF callbacks from browser mock engines and external
  WebSocket device sync.
- **In-Phone DevTools**: Embedded developer control panel in Settings app for
  browser testing (power button, volume HUD overlay, battery drain, signal
  levels, call/SMS/email simulation).
- **Click & Drag Touch/Mouse Scrolling**: Universal pointer drag-scrolling
  delegation across all phone screens and scrollable containers with hidden
  scrollbar styling.
- **Dynamic App Registry**: Reactive `appRegistryStore` supporting persistent
  `firstBoot` timestamps, app installation dates, runtime third-party app
  registration (`registerApp`, `unregisterApp`), and home screen grid updates.
- **Framework Bridge**: Built-in support for **QBX Core** (`qbx_core`) and
  **QBCore** (`qb-core`) with automatic player lookup and money handlers.
- **Banking Bridge**: Reads transaction history through the banking resource's
  own exports rather than its tables (**Renewed-Banking** supported),
  normalizing each script's record shape onto one contract. Degrades to an empty
  list when no supported resource is present.
- **Declarative Server Schema**: Each app declares its server half once via
  `defineService` — the schema drives the SQL identifier allowlist, the
  client-writable field set, and the generated DDL in `gphone.sql`, so they
  cannot drift apart.
- **Inventory Integration**: Out-of-the-box support for `ox_inventory` item
  registration and removal.
- **Central Audit Logging**: Comprehensive action auditing (`gphone_audit_logs`)
  tracking archive, deletion, moderation, and participant events.
- **Animation & Control**: Client-side animation, camera capture, and freelook
  camera systems.

---

## Tech Stack

- **Frontend**: [Svelte 5](https://svelte.dev/) — runes for component-local
  state only; global state is `writable`/`derived` **stores**, one file per
  domain, in `web/src/services/` (server-backed caches) and
  `web/src/shell/state/` (state the phone itself owns).
  [Vite](https://vitejs.dev/), hand-written CSS (Material 3 tokens + a utility
  layer), [TypeScript 6](https://www.typescriptlang.org/). Tested with
  [Playwright](https://playwright.dev/) (E2E) and [Vitest](https://vitest.dev/)
  (unit).
- **Backend (Client/Server)**: TypeScript 7 compiled via high-performance
  `esbuild` pipeline (8–12x typecheck speedup)
- **Runtime transport**: a pluggable `ITransportAdapter`
  (`web/src/nui/transport.ts`) — `NuiTransportAdapter` talks to FiveM's CEF over
  `fetch()`/`window.message`, `MockTransportAdapter` answers from fixtures in a
  plain browser, and `WebSocketTransportAdapter` is available for
  remote-device/external sync, with reconnection and request timeouts built in.
- **Database**: MySQL / MariaDB via `oxmysql` with foreign keys, compound
  indexes, and status moderation
- **Package Manager**: `pnpm` Workspaces — `web/` is a separate pnpm package
  (and pinned to TypeScript 6) so its typechecking tool, which needs an older
  compiler API, can stay on a different TS version than `client/`/`server/`
  (TypeScript 7) without either side compromising; see
  [AGENTS.md §3](AGENTS.md#3-typescript-is-split-by-package--on-purpose).

---

## Requirements

Before installing, ensure your server environment meets the following
requirements:

- **Node.js**: 26.x — what CI builds on and what the development machine runs
- **pnpm**: 11.x
- **FiveM Artifacts**: Recommended recent server build
- **Dependencies**:
  - `oxmysql`
  - Framework: `qbx_core` or `qb-core`
  - _(Optional)_ `ox_inventory`

---

## Installation & Setup

1. **Clone Repository** Clone or download `gphone` into your server's
   `resources` directory (e.g., `resources/[standalone]/gphone`).

2. **Database Setup** Import [`gphone.sql`](gphone.sql). That is the whole
   schema — the moderation audit ledger and every app table, in dependency
   order, so foreign keys resolve as it runs.

   It is **generated** by `pnpm generate:sql` from each app's `defineService`
   declaration, which is the single source of truth: the same declaration drives
   the SQL identifier allowlist that guards against injection, so a second
   hand-maintained copy of the DDL would not just drift, it would quietly weaken
   that guard.

   Every statement is `CREATE TABLE IF NOT EXISTS`, so re-importing is harmless
   — and does nothing to a table that already exists. gPhone applies no schema
   changes automatically: `gphoneschema` in the server console reports any
   difference between the database and what the code expects, and
   `gphoneschema apply` — console-only — applies the safe, additive half of that
   difference plus any pending versioned migration. A rename, a retype or a drop
   still needs its migration written and reviewed first; `apply` only ever runs
   migrations that already exist in `server/migrations/`.

   **Resetting the schema during development:** `pnpm generate:sql:reset`
   additionally writes `sql/dev-reset.sql`, which **drops every
   `gphone_`-prefixed table in the schema you run it against** — including the
   audit ledger — and then recreates everything. It discovers tables from
   `information_schema` at apply time, so it also clears orphans left behind by
   a renamed table.

   Development only, and never run against a live server. It is gitignored and
   is not produced by plain `pnpm generate:sql`.

3. **Install Dependencies & Build** Navigate to the resource directory and
   execute `pnpm` scripts:

   ```sh
   pnpm install
   pnpm build
   ```

4. **Resource Manifest** Ensure `gphone` is started in your `server.cfg`:

   ```cfg
   ensure oxmysql
   ensure qbx_core # or qb-core
   ensure gphone
   ```

---

## Development

gPhone uses `pnpm` workspaces for concurrent frontend and client/server
development with live hot-reloading:

### Start Development Server

```sh
pnpm dev
```

This runs watch scripts for client/server bundles (`pnpm watch`) and the Vite
web development server (`pnpm watch:web`) concurrently.

### Every Gate, One Command

`pnpm verify` runs the full pipeline in order — barrels, format, container,
typecheck, unit, e2e, build, dead-code. Every gate runs even after one fails,
and the summary names all of them, so one bad gate cannot hide the state of the
rest. CI runs the same command, so a green local run means a green CI run.

```sh
pnpm verify         # every gate, every failure reported
pnpm verify:quick   # skips e2e only — what the pre-push hook runs
pnpm verify --bail  # stop at the first failing gate, for a fast inner loop
```

`--quick` drops e2e and nothing else. It used to drop `build` and `dead-code`
too, which meant the only place they ran was CI: a dead-code failure sat on
`main` for four commits because `dead-code` runs after `e2e`, and `e2e` is flaky
on some machines under full-suite load. Between them those two gates cost about
fifteen seconds, which is worth paying before a push.

Check its exit code rather than eyeballing the output: piping it through `tail`
reports `tail`'s status, not the suite's.

### The Web Demo Container

The phone in a browser with no FiveM server behind it — the shipped NUI bundle
served standalone against the mock transport. One static binary and one
directory of static files on `scratch`, 3.62 MB all in.

```sh
pnpm demo          # build and serve on http://127.0.0.1:8080
pnpm demo:up       # same, detached
pnpm demo:down     # stop and remove
pnpm demo:smoke    # probe a running container
```

It binds to `127.0.0.1`, not every interface, and runs read-only with all
capabilities dropped. This is not a development loop — there is no bind mount
and no live reload, because `pnpm dev` already does that better. See
[docs/demo-container.md](docs/demo-container.md) for stamping a real version
into Settings > About, the `TZ` and port knobs, and what the gates check.

### Scaffolding an App

```sh
pnpm new:app journal            # the app
pnpm new:app journal --service  # and its server half
```

Then `pnpm dev` and open `http://localhost:5173/?app=journal` to boot straight
into it instead of clicking through the launcher.

### Type Checking

Run type checks across all three targets (client, server, and web):

```sh
pnpm typecheck
```

### Testing & Quality Assurance

Run unit test suites (Vitest for service caches, shell state, helpers, SDK, and
transport adapters) and Playwright End-to-End (E2E) test suites:

```sh
# Run all unit tests (Vitest)
pnpm test:unit

# Run full Playwright E2E suite
pnpm --filter web test:e2e

# Run headed E2E test in visual browser window
pnpm --filter web test:e2e:headed

# Serve interactive Playwright HTML Web View Report at http://localhost:9323
pnpm --filter web test:e2e:report
```

---

## Exports for other resources

gPhone publishes a small API so other scripts can reach the phone. Every export
returns a discriminated outcome rather than a bare boolean — a `false` that
cannot tell you "the player is offline" from "gPhone has not started yet" leaves
you guessing — and no export ever throws into your resource.

```lua
local result = exports['gphone']:SendNotification(citizenid, {
    app         = 'ext_towing',      -- your own group, or a gPhone app id
    sourceLabel = 'Tow Company',     -- required for ext_, shown in the shade
    title       = 'Job available',
    body        = 'Pickup at Sandy Shores',
    deepLink    = nil                -- optional; see BuildDeepLink
})

if not result.ok then
    print(('gphone refused: %s (%s)'):format(result.message, result.reason))
end
```

`reason` is one of `unknown_player`, `offline`, `not_ready`, `invalid_args` or
`internal_error`.

| Export                              | Identifies a player by | Does                                                                                              |
| ----------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------- |
| `GetApiVersion()`                   | —                      | The API version. Bumped when an existing export changes shape, not when one is added              |
| `SendSystemEmail(...)`              | citizenid              | Sends mail. Predates this API and keeps its original signature                                    |
| `SendNotification(citizenid, opts)` | citizenid              | Raises a notification. Works offline — the row is written and shown next time they open the phone |
| `BuildDeepLink(app, props)`         | —                      | Builds a `app?key=value` link without needing to know the format                                  |
| `AddMedia(citizenid, media)`        | citizenid              | Puts a GIF, a video poster, a voice clip or a file in a player's gallery                          |
| `AddContact(citizenid, contact)`    | citizenid              | Adds a contact to a player's address book. Works offline, same as `AddMedia`                      |
| `GetPhoneNumber(citizenid)`         | citizenid              | The phone number for a citizenid, online or off                                                   |
| `GetCitizenId(phone)`               | —                      | The reverse lookup: whose phone number is this                                                    |
| `IsPhoneOpen(source)`               | source                 | Whether that player's phone is open right now                                                     |
| `SetPhoneEnabled(source, enabled)`  | source                 | Confiscates or returns a player's phone; disabling while open force-closes it                     |
| `OpenApp(source, appId, props)`     | source                 | Force-opens the phone on a named app; `props` becomes that app's `useDeepLink` payload            |
| `GetBatteryLevel(source)`           | source                 | The saved charge, 0-100                                                                           |
| `SetBatteryLevel(source, level)`    | source                 | Sets the charge. Clamped rather than refused                                                      |
| `AddBatteryCharge(source, delta)`   | source                 | Adds or, with a negative delta, drains — an EMP, a taser                                          |
| `SetCharging(source, isCharging)`   | source                 | Puts the phone on or off charge. A state, not a top-up: it reverses the drain loop                |
| `SetGlobalSignal(level)`            | —                      | City-wide reception, 0-4. `0` is a blackout                                                       |
| `ClearGlobalSignal()`               | —                      | Back to full bars                                                                                 |
| `AddDeadZone({x,y,z,radius,level})` | —                      | A jammer, a tunnel, a basement. Returns an id                                                     |
| `RemoveDeadZone(id)`                | —                      | Removes one by the id `AddDeadZone` gave you                                                      |
| `SetSignal(source, level)`          | source                 | One player, overriding the zones. `null` hands them back to the world                             |
| `GetSignal(source)`                 | source                 | The rules they are subject to — not their bars, which depend on where they stand                  |

**citizenid or source, and it matters which.** Anything that must work while the
player is offline takes a citizenid; anything inherently live takes a source. No
export reads an implicit `source` global, because `TriggerEvent` from another
resource would make that the wrong player.

**`AddMedia` is how anything but a photo gets in.** The camera only ever
produces a `photo`, so the other six kinds — `video`, `audio`, `gif`, `sticker`,
`file`, `link` — exist only through this export. Pass either `url` (http(s)
only) or `data` (base64); a `video` also wants a `thumbnail`, since gPhone draws
the poster frame rather than playing the clip.

**Reception is one primitive with a precedence order**, not two. A blackout is a
global level, a jammer is a zone, and the lowest applicable value wins — so they
cannot disagree. A per-player `SetSignal` beats both, in either direction, which
is what makes it possible to give somebody bars _inside_ a blackout.

Bars are evaluated on each player's own client against the rules the server
pushes, because the server does not know where anybody is standing and asking
every player every tick is the cost this design avoids. A modified client can
therefore lie about its own bars — deliberately fine, since signal gates
presentation and never authority.

**`ext_<resource>` is reserved for you.** Notifications raised under it get
their own group in the shade, labelled with your `sourceLabel`. gPhone apps are
forbidden from taking an `ext_` id, so your group can never be silently merged
with one shipped later.

---

## Repository Structure

```text
gphone/
├── client/                       # Client-side systems (Animation, Battery, Camera, Call, Relay, etc.)
├── server/                       # Server-side services, FrameworkBridge, AuditLogger, & Database access
├── shared/                       # Shared types, interfaces, and constants
├── web/                          # Svelte 5 + Vite frontend application (hand-written CSS)
│   └── src/
│       ├── apps/                 # One directory per app — the registry discovers them, nothing registers them
│       ├── sdk/                  # @gphone/sdk: the only thing an app may import
│       ├── shell/                # The phone around the apps: frame, launcher, navigation, state
│       └── services/             # Stores backing the SDK hooks; apps reach these through the SDK, never by path
├── docker/serve/                 # The demo image's static file server (Go, stdlib only)
├── scripts/                      # Manifest generation, SQL generation, and build automation
├── build/                        # esbuild bundle configuration
├── gphone.sql                    # Generated: the whole schema (pnpm generate:sql)
├── scripts/framework-schema.sql  # Hand-written: the moderation audit ledger
└── fxmanifest.lua                # Resource manifest file
```

---

## Contributing

- [docs/writing-an-app.md](docs/writing-an-app.md) — the five-minute path to a
  working app.
- [docs.gphone.site](https://docs.gphone.site/) — the generated `@gphone/sdk`
  API reference.
- [docs/demo-container.md](docs/demo-container.md) — the demo image: running it,
  and what it ships.
- [docs/addon-catalog.md](docs/addon-catalog.md) — the `CatalogEntry` shape a
  Store backend serves to describe an installable `core: false` add-on.
- [docs/architecture.md](docs/architecture.md),
  [docs/schema-and-services.md](docs/schema-and-services.md),
  [docs/security.md](docs/security.md), [docs/dev-loop.md](docs/dev-loop.md) —
  why the layout looks the way it does, the service/schema layer, the security
  model, and the fast local test loop.
- [AGENTS.md](AGENTS.md) — the full engineering guide: hard constraints (§2),
  the CEF capability baseline (§6), the service layer (§10), and adding an app
  end to end (§11). Written for AI agents working in this repo, and the most
  complete description of how it fits together.

Planning lives in the Jira project **MICA**, and nowhere else — there is no
roadmap file in this repo and re-adding one is explicitly out of bounds
(AGENTS.md §2.11). A design doc or phased plan here should name the issue key it
corresponds to (`MICA-16`) — the key, never the site URL.

`pnpm verify` is the gate for any change, and CI runs the same command.

---

## License

This project is open-source and licensed under the
[GNU Affero General Public License v3.0 (AGPL-3.0)](LICENSE).
