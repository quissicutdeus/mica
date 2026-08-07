<h1 align="center">gPhone</h1>

<p align="center">
  <b>A modern, open-source custom phone resource for FiveM</b> — <a href="https://gphone.site/">Live Demo</a><br/>
  Powered by TypeScript, Svelte 5, Vite, Tailwind CSS v4, and esbuild.
</p>

---

## Overview

**gPhone** is a feature-rich, open-source smartphone resource designed for FiveM servers. Built from the ground up using modern web technologies and a decoupled TypeScript architecture, gPhone provides a slick, realistic mobile experience for players and seamless framework integration for server developers.

---

## Key Features

### 📱 Applications & UI

- **Phone & Dialer**: Full contact dialing, active call management, and custom in-game phone prop animations.
- **Contacts**: Contact management with favoriting, custom avatars, and soft deletion.
- **Messages**: Individual and group messaging with support for image attachments directly linked to the photo gallery.
- **Mail System**: Dedicated email application with full database integration and unread status indicators.
- **Banking**: Dynamic bank card generation based on player citizen ID, live balance tracking, and transfer handling.
- **Photos & Camera**: In-game screenshot/camera integration, automatic image compression, gallery view, and attachment sharing.
- **Notes**: Full-featured note-taking app with instant saving.
- **Calculator**: Full mathematical calculator with an optimized touchscreen keypad layout.
- **Blabber** _(add-on)_: Short public posts under an `@handle`. Replies, **mouths** (a repeat, or a quote when you add your own words), likes, `@mention` notifications, and strictly one-to-one direct messages. Follow an account and its posts turn up in a Following feed of their own; the counts on a profile open the lists behind them. An author can fix a typo for 15 minutes — `gphone_blabber_edit_window` — and then the post freezes. A player may hold several accounts and switch between them, and the owning `citizenid` never reaches another reader, so alts stay uncorrelated. Not on the home screen out of the box: it is the first genuinely non-core app and installs from the Store.
- **Store Application**: Built-in app marketplace to browse, install, and manage community add-on apps. Features Installed tab sorting (`newest`, `oldest`, `updated`, `name`), installation date metrics (`installedAt`, `updatedAt`), permissions inspector, and app storage footprint metrics.
- **Settings & Status**: Settings application with an **About** section (phone number, OS version, first boot timestamp, and smart git build/commit info), 24-hour time toggles, embedded Developer Tools, dynamic battery drain lifecycle, and hardware controls.
- **Home Screen Edit Mode**: Right-click icon gesture to trigger Edit Mode, swapping unread notification badges for gray minus action buttons on removable add-on apps with automatic Edit Mode exit when no add-on apps remain.

### 🛠️ Backend & Core Architecture

- **SDK-First Architecture (`@gphone/sdk`)**: OS hooks for data (`useContacts`, `usePhotos`, `useMail`, `useNotes`, `useMessages`, `useBlabber`, `useAccount`, `useCall`, `useReports`), for the device (`useSystemHardware`, `useClock`, `useDisplay`, `useCamera`, `useSound`, `useKeybinds`, `useNuiBridge`), and for the app itself (`useNavigation`, `useAppLevels`, `useAppAction`, `useStorage`, `usePersisted`, `useTimer`, `useDeepLink`, `usePagedList`, `usePhoneNotification`, `useAppRegistry`, `useAppEvents`). Plus `AppProps` — the one boundary every app crosses, and typechecked. Apps import the SDK and nothing else, enforced by a test rather than documented and hoped for.
- **Written for app authors**: `pnpm new:app <id>` scaffolds a working app, `localhost:5173/?app=<id>` boots straight into one, and `renderApp` from `@gphone/sdk/testing` unit-tests one. See [docs/writing-an-app.md](docs/writing-an-app.md).
- **Client & NUI Transport Safety**: Deterministic ID generation and 15-second safety timeouts (`ClientApp.ts`) preventing NUI callbacks from hanging CEF indefinitely.
- **Core vs. Add-on Protection Engine**: Every manifest declares `core` explicitly — `true` ships with the phone and cannot be uninstalled, `false` is a Store-managed add-on. Stated rather than inferred, because it was once derived from the app's `author` string, which made a display value decide whether an app could be removed. A remote bundle is never core.
- **App Isolation & Guardrails**: Wrapped dynamic app rendering with Svelte 5 `<svelte:boundary>` (`ErrorBoundary.svelte`) preventing third-party app runtime exceptions from locking FiveM NUI mouse focus or breaking OS navigation.
- **Dual-Runtime Transport Abstraction**: Pluggable `ITransportAdapter` layer (`NuiTransportAdapter`, `MockTransportAdapter`, `WebSocketTransportAdapter`) cleanly separating FiveM CEF callbacks from browser mock engines and external WebSocket device sync.
- **In-Phone DevTools**: Embedded developer control panel in Settings app for browser testing (power button, volume HUD overlay, battery drain, signal levels, call/SMS/email simulation).
- **Click & Drag Touch/Mouse Scrolling**: Universal pointer drag-scrolling delegation across all phone screens and scrollable containers with hidden scrollbar styling.
- **Dynamic App Registry**: Reactive `appRegistryStore` supporting persistent `firstBoot` timestamps, app installation dates, runtime third-party app registration (`registerApp`, `unregisterApp`), and home screen grid updates.
- **Framework Bridge**: Built-in support for **QBX Core** (`qbx_core`) and **QBCore** (`qb-core`) with automatic player lookup and money handlers.
- **Banking Bridge**: Reads transaction history through the banking resource's own exports rather than its tables (**Renewed-Banking** supported), normalizing each script's record shape onto one contract. Degrades to an empty list when no supported resource is present.
- **Declarative Server Schema**: Each app declares its server half once via `defineService` — the schema drives the SQL identifier allowlist, the client-writable field set, and the generated DDL in `sql/apps/`, so they cannot drift apart.
- **Inventory Integration**: Out-of-the-box support for `ox_inventory` item registration and removal.
- **Central Audit Logging**: Comprehensive action auditing (`gphone_audit_logs`) tracking archive, deletion, moderation, and participant events.
- **Animation & Control**: Client-side animation, camera capture, and freelook camera systems.

---

## Tech Stack

- **Frontend**: [Svelte 5](https://svelte.dev/), [Vite](https://vitejs.dev/), [Tailwind CSS v4](https://tailwindcss.com/), [TypeScript 6](https://www.typescriptlang.org/)
- **Backend (Client/Server)**: TypeScript 7 compiled via high-performance `esbuild` pipeline (8–12x typecheck speedup)
- **Database**: MySQL / MariaDB via `oxmysql` with foreign keys, compound indexes, and status moderation
- **Package Manager**: `pnpm` Workspaces

---

## Requirements

Before installing, ensure your server environment meets the following requirements:

- **Node.js**: >= 20.x
- **pnpm**: >= 9.x
- **FiveM Artifacts**: Recommended recent server build
- **Dependencies**:
  - `oxmysql`
  - Framework: `qbx_core` or `qb-core`
  - _(Optional)_ `ox_inventory`

---

## Installation & Setup

1. **Clone Repository**
   Clone or download `gphone` into your server's `resources` directory (e.g., `resources/[standalone]/gphone`).

2. **Database Setup**
   Import [`gphone.sql`](gphone.sql) — the framework schema, which is just the moderation audit ledger — and then every file in [`sql/apps/`](sql/apps), which holds one file per service (accounts, battery, blabber, blabber_dms, contacts, conversations, mail, notes, photos, messages, reports) including their join and attachment tables.

   **Import them in filename order.** The numeric prefix is apply order, not decoration: foreign keys cross app boundaries, so `gphone_blabber` needs `gphone_accounts` to exist first and the messages app's attachment table references `gphone_media`. Alphabetical order gets both wrong. The files are generated in dependency order, so importing the directory as it sorts is correct by default — and the prefixes shift when an app is added, which is expected.

   App tables are **generated** from each app's `defineService` declaration by `pnpm generate:sql`, so the declaration is the single source of truth for the schema. They are deliberately not duplicated into `gphone.sql`: two hand-maintained copies of the same DDL drift, and the column allowlist that protects against SQL injection is only safe while it matches the real table.

   Every statement is `CREATE TABLE IF NOT EXISTS`, so re-importing is harmless — on a **fresh** database. That is also its limitation: against a database that already has the table, it succeeds and changes nothing.

   > **Upgrading an existing install?** Check [`sql/migrations/`](sql/migrations) first, and run anything there instead of the matching file in `sql/apps/`. Back up before you do.
   >
   > A migration exists because a rename or a type change cannot be applied automatically — gPhone's schema migrator is additive-only, so it adds missing columns and indexes at resource start but will never drop, rename or retype one, since none of those is safe to infer from a diff.
   >
   > **`001-photos-to-media.sql`** renames `gphone_photos` to `gphone_media` and `image` to `data`. Skipping it and running `sql/apps/10-photos.sql` instead creates an _empty_ `gphone_media` and leaves every player's gallery stranded in the old table — nothing is deleted, but the photos vanish from the phone. Run `gphoneschema` in the server console afterwards to confirm the database matches what the code expects; it reports without changing anything.

   <details>
   <summary>Resetting the schema during development</summary>

   `pnpm generate:sql:reset` additionally writes `sql/dev-reset.sql`, which **drops every `gphone_`-prefixed table in the schema you run it against** — including the audit ledger — and then recreates everything. It discovers tables from `information_schema` at apply time, so it also clears orphans left behind by a renamed table.

   Development only, and never run against a live server. It is gitignored and is not produced by plain `pnpm generate:sql`.

   </details>

3. **Install Dependencies & Build**
   Navigate to the resource directory and execute `pnpm` scripts:

   ```sh
   pnpm install
   pnpm build
   ```

4. **Resource Manifest**
   Ensure `gphone` is started in your `server.cfg`:
   ```cfg
   ensure oxmysql
   ensure qbx_core # or qb-core
   ensure gphone
   ```

---

## Development

gPhone uses `pnpm` workspaces for concurrent frontend and client/server development with live hot-reloading:

### Start Development Server

```sh
pnpm dev
```

This runs watch scripts for client/server bundles (`pnpm watch`) and the Vite web development server (`pnpm watch:web`) concurrently.

### Every Gate, One Command

`pnpm verify` runs the full pipeline in order — barrels, format, typecheck, unit, e2e, build,
dead-code — and stops at the first failure. CI runs the same command, so a green local run means
a green CI run.

```sh
pnpm verify         # everything
pnpm verify:quick   # skips e2e and build, for a fast inner loop
```

Check its exit code rather than eyeballing the output: piping it through `tail` reports `tail`'s
status, not the suite's.

### Scaffolding an App

```sh
pnpm new:app journal            # the app
pnpm new:app journal --service  # and its server half
```

Then `pnpm dev` and open `http://localhost:5173/?app=journal` to boot straight into it instead of
clicking through the launcher.

### Type Checking

Run type checks across all three targets (client, server, and web):

```sh
pnpm typecheck
```

### Testing & Quality Assurance

Run unit test suites (Vitest for service caches, shell state, helpers, SDK, and transport adapters) and Playwright End-to-End (E2E) test suites:

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

gPhone publishes a small API so other scripts can reach the phone. Every export returns a
discriminated outcome rather than a bare boolean — a `false` that cannot tell you "the player is
offline" from "gPhone has not started yet" leaves you guessing — and no export ever throws into your
resource.

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

`reason` is one of `unknown_player`, `offline`, `not_ready`, `invalid_args` or `internal_error`.

| Export                              | Identifies a player by | Does                                                                                              |
| ----------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------- |
| `GetApiVersion()`                   | —                      | The API version. Bumped when an existing export changes shape, not when one is added              |
| `SendSystemEmail(...)`              | citizenid              | Sends mail. Predates this API and keeps its original signature                                    |
| `SendNotification(citizenid, opts)` | citizenid              | Raises a notification. Works offline — the row is written and shown next time they open the phone |
| `BuildDeepLink(app, props)`         | —                      | Builds a `app?key=value` link without needing to know the format                                  |
| `GetBatteryLevel(source)`           | source                 | The saved charge, 0-100                                                                           |
| `SetBatteryLevel(source, level)`    | source                 | Sets the charge. Clamped rather than refused                                                      |
| `AddBatteryCharge(source, delta)`   | source                 | Adds or, with a negative delta, drains — an EMP, a taser                                          |
| `SetCharging(source, isCharging)`   | source                 | Puts the phone on or off charge. A state, not a top-up: it reverses the drain loop                |

**citizenid or source, and it matters which.** Anything that must work while the player is offline
takes a citizenid; anything inherently live takes a source. No export reads an implicit `source`
global, because `TriggerEvent` from another resource would make that the wrong player.

**`ext_<resource>` is reserved for you.** Notifications raised under it get their own group in the
shade, labelled with your `sourceLabel`. gPhone apps are forbidden from taking an `ext_` id, so your
group can never be silently merged with one shipped later.

---

## Repository Structure

```
gphone/
├── client/           # Client-side systems (Animation, Battery, Camera, Call, Relay, etc.)
├── server/           # Server-side services, FrameworkBridge, AuditLogger, & Database access
├── shared/           # Shared types, interfaces, and constants
├── web/              # Svelte 5 + Vite + Tailwind CSS v4 frontend application
│   └── src/
│       ├── apps/     # One directory per app — the registry discovers them, nothing registers them
│       ├── sdk/      # @gphone/sdk: the only thing an app may import
│       ├── shell/    # The phone around the apps: frame, launcher, navigation, state
│       └── services/ # Stores backing the SDK hooks; apps reach these through the SDK, never by path
├── scripts/          # Manifest generation, SQL generation, and build automation
├── build/            # esbuild bundle configuration
├── sql/apps/         # Generated per-app tables + join tables (pnpm generate:sql)
├── gphone.sql        # Framework schema (moderation audit ledger)
└── fxmanifest.lua    # Resource manifest file
```

---

## Contributing

- [docs/writing-an-app.md](docs/writing-an-app.md) — the five-minute path to a working app.
- [AGENTS.md](AGENTS.md) — the full engineering guide: hard constraints (§2), the CEF capability
  baseline (§6), the service layer (§10), and adding an app end to end (§11). Written for AI
  agents working in this repo, and the most complete description of how it fits together.

`pnpm verify` is the gate for any change, and CI runs the same command.

---

## License

This project is open-source and licensed under the [GNU Affero General Public License v3.0 (AGPL-3.0)](LICENSE).
