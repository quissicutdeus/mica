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
- **Store Application**: Built-in app marketplace to browse, install, and manage community add-on apps. Features Installed tab sorting (`newest`, `oldest`, `updated`, `name`), installation date metrics (`installedAt`, `updatedAt`), permissions inspector, and app storage footprint metrics.
- **Settings & Status**: Settings application with an **About** section (phone number, OS version, first boot timestamp, and smart git build/commit info), 24-hour time toggles, embedded Developer Tools, dynamic battery drain lifecycle, and hardware controls.
- **Home Screen Edit Mode**: Right-click icon gesture to trigger Edit Mode, swapping unread notification badges for grey minus action buttons on removable add-on apps with automatic Edit Mode exit when no add-on apps remain.

### 🛠️ Backend & Core Architecture

- **SDK-First Architecture (`@gphone/sdk`)**: Complete OS service hook coverage (`useNavigation`, `usePhoneNotification`, `useContacts`, `useCamera`, `useAppRegistry`, `useAccount`, `useCall`, `useMail`, `useNotes`, `useMessages`, `useStorage`, `useSystemHardware`, `useNuiBridge`) and domain type exports (`Transaction`, `UIMessage`, `UIConversation`, `Contact`, `Mail`, `Note`), eliminating internal store imports from app modules.
- **Client & NUI Transport Safety**: Deterministic ID generation and 15-second safety timeouts (`ClientApp.ts`) preventing NUI callbacks from hanging CEF indefinitely.
- **System vs. Add-on Protection Engine**: Immutable System App protection for core OS apps alongside dynamic Add-on app management and granular permission auditing.
- **App Isolation & Guardrails**: Wrapped dynamic app rendering with Svelte 5 `<svelte:boundary>` (`ErrorBoundary.svelte`) preventing third-party app runtime exceptions from locking FiveM NUI mouse focus or breaking OS navigation.
- **Dual-Runtime Transport Abstraction**: Pluggable `ITransportAdapter` layer (`NuiTransportAdapter`, `MockTransportAdapter`, `WebSocketTransportAdapter`) cleanly separating FiveM CEF callbacks from browser mock engines and external WebSocket device sync.
- **In-Phone DevTools**: Embedded developer control panel in Settings app for browser testing (power button, volume HUD overlay, battery drain, signal levels, call/SMS/email simulation).
- **Click & Drag Touch/Mouse Scrolling**: Universal pointer drag-scrolling delegation across all phone screens and scrollable containers with hidden scrollbar styling.
- **Dynamic App Registry**: Reactive `appRegistryStore` supporting persistent `firstBoot` timestamps, app installation dates, runtime third-party app registration (`registerApp`, `unregisterApp`), and home screen grid updates.
- **Framework Bridge**: Built-in support for **QBX Core** (`qbx_core`) and **QBCore** (`qb-core`) with automatic player lookup and money handlers.
- **Inventory Integration**: Out-of-the-box support for `ox_inventory` item registration and removal.
- **Central Audit Logging**: Comprehensive action auditing (`gphone_audit_logs`) tracking archive, deletion, moderation, and participant events.
- **Animation & Control**: Client-side animation controllers, camera capture controllers, and freelook camera handling.

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
   Import the [`gphone.sql`](gphone.sql) schema into your MySQL/MariaDB database. This creates all necessary tables including contacts, messages, photos, mail, notes, and audit logs.

   Apps that declare their own schema also emit a table definition under [`sql/apps/`](sql/apps). Those files are generated by `pnpm generate:sql` and applied the same way — import any that your database does not already have. They are additive: an app whose table is already covered by `gphone.sql` needs nothing further.

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

### Type Checking

Run type checks across all modules (client, server, and web):

```sh
pnpm typecheck
```

### Testing & Quality Assurance

Run unit test suites (Vitest for all stores, utilities, SDK helpers, and transport bridge adapters) and Playwright End-to-End (E2E) test suites:

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

## Repository Structure

```
gphone/
├── client/           # Client-side TypeScript controllers (Animation, Battery, Camera, Call, etc.)
├── server/           # Server-side controllers, FrameworkBridge, AuditLogger, & Database access
├── shared/           # Shared types, interfaces, and constants
├── web/              # Svelte 5 + Vite + Tailwind CSS v4 frontend application
├── scripts/          # Manifest generation, SQL generation, and build automation
├── build/            # esbuild bundle configuration
├── sql/apps/         # Generated per-app table definitions (pnpm generate:sql)
├── gphone.sql        # Base database table definitions and foreign keys
└── fxmanifest.lua    # Resource manifest file
```

---

## License

This project is open-source and licensed under the [GNU Affero General Public License v3.0 (AGPL-3.0)](LICENSE).
