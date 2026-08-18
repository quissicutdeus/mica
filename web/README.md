# gPhone Web Interface

This directory contains the Svelte 5 frontend application and NUI bridge for **[gPhone](https://gphone.site/)**, a custom smartphone resource for FiveM.

---

## 🚀 Tech Stack

- **Framework**: [Svelte 5](https://svelte.dev/) — runes (`$state`, `$derived`, `$effect`) for component-local state only. Global state is `writable`/`derived` **stores** in `src/services/` and `src/shell/state/`, one file per domain. This split is a policy rather than a leftover: see [`AGENTS.md` §4](../AGENTS.md), which is the authority, and do not introduce `.svelte.ts` rune-based state modules or convert existing stores.
- **Build Tool**: [Vite](https://vitejs.dev/)
- **Styling**: Hand-written CSS — Material 3 design tokens in `src/app.css`, a flat utility layer in `src/app-utilities.css`
- **Language**: [TypeScript](https://www.typescriptlang.org/)
- **Testing**: [Playwright](https://playwright.dev/) (E2E) & [Vitest](https://vitest.dev/) (Unit)

---

## 📁 Directory Structure

```text
web/
├── e2e/                # Playwright End-to-End test suites
│   ├── apps/           # Individual app E2E tests (Admin, Bank, Blabber, Bluetooth Share, Calculator, Camera,
│   │                   # Contacts, Mail, Media, Messages, Notes, Phone, Settings, Sound, Store)
│   ├── app-residency.spec.ts
│   ├── deep-link.spec.ts        # the dev `?app=` deep link
│   ├── deep-links.spec.ts       # notification deep-link routing
│   ├── display.spec.ts
│   ├── defects.spec.ts
│   ├── error_boundary.spec.ts
│   ├── keybinds.spec.ts
│   ├── navigation.spec.ts
│   ├── notifications.spec.ts
│   ├── nui.spec.ts
│   ├── settings-persistence.spec.ts
│   └── theme-modes.spec.ts
├── src/
│   ├── apps/           # One directory per app (admin, bank, blabber, calculator, camera, contacts, mail, media,
│   │                   # messages, notes, phone, settings, store)
│   ├── shell/          # The OS itself: Shell.svelte, PhoneFrame, Launcher, ToastHost, VolumeHud, ErrorBoundary
│   │   └── state/      # State the phone owns (appEvents, audio, bluetooth, bootstrap, charge, devtools, display,
│   │                   # keybinds, navigation, notificationSettings, registry, seedFromImage, shade, signal,
│   │                   # theme, time, toast, wallpaper)
│   ├── services/       # Client-side cache of each core service (account, admin, call, camera, contacts,
│   │                   # conversations, mail, media, notifications, reports, settings) plus the two factories
│   │                   # they are built from: createCrudStore, createPagedStore. An add-on's store — Notes,
│   │                   # Blabber — lives beside its app in src/apps/ instead; see AGENTS.md §8/§11.
│   ├── sdk/            # @gphone/sdk — the only thing apps may import
│   │   └── ui/         # UI primitives and icons apps build with
│   ├── nui/            # The bridge: transport adapters, fetchNui, useNuiEvent, browser mocks
│   ├── lib/            # Helpers with no gPhone state and no I/O (debug, dragRatio, dragScroll, errors,
│   │                   # filterByQuery, formatters, isBrowser, m3, markdown, pointerDrag, useScrollDetect)
│   └── main.ts         # Mounts shell/Shell.svelte
├── package.json
└── playwright.config.ts
```

---

## 🧪 Testing Operations

gPhone includes a full suite of automated unit (Vitest) and Playwright End-to-End (E2E) tests.

### Running Unit Tests

Run unit test suites covering the core service caches (`account`, `admin`, `call`, `camera`, `contacts`, `conversations`, `mail`, `media`, `notifications`, `reports`, `settings`) and the `createCrudStore`/`createPagedStore` factories behind them, shell state (`appEvents`, `audio`, `bluetooth`, `bootstrap`, `charge`, `display`, `keybinds`, `navigation`, `registry`, `shade`, `signal`, `theme`, `time`, `toast`, `wallpaper`), transport adapters, SDK helpers and boundaries, and the pure helpers in `lib/`:

```sh
pnpm test:unit
```

### Running E2E Tests

The Playwright test suite covers full application flows, NUI events, app error boundaries, interactive notification deep-linking, and form validation across all phone apps:

```sh
# Run full headless E2E test suite
pnpm test:e2e

# Visually observe tests running in a single-worker headed Chrome window
pnpm test:e2e:headed

# Serve the HTML Web View Report at http://localhost:9323
pnpm test:e2e:report
```

---

## 🛠️ Standalone Development vs. FiveM CEF (Pluggable Transport Layer)

gPhone uses a pluggable `ITransportAdapter` abstraction layer to handle event communication across runtime environments:

- **Standalone Browser Mode (`MockTransportAdapter`)**: Running `pnpm dev` launches the web app on `http://localhost:5173`. Callbacks dynamically resolve from `MockRegistry` data fixtures.
- **FiveM CEF NUI Mode (`NuiTransportAdapter`)**: Inside FiveM, callbacks issue `fetch('https://<resource>/<event>')` requests and handle incoming NUI `window.message` events seamlessly.
- **Remote Device & External Sync (`WebSocketTransportAdapter`)**: Connects gPhone to external WebSockets with automatic reconnection, timeouts, and transparent NUI event broadcasting for remote control and external browser sync.
