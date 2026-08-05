# gPhone Web Interface

This directory contains the Svelte 5 frontend application and NUI bridge for **[gPhone](https://gphone.site/)**, a custom smartphone resource for FiveM.

---

## 🚀 Tech Stack

- **Framework**: [Svelte 5](https://svelte.dev/) — runes (`$state`, `$derived`, `$effect`) for component-local state only. Global state is `writable`/`derived` **stores** in `src/services/` and `src/shell/state/`, one file per domain. This split is a policy rather than a leftover: see [`AGENTS.md` §4](../AGENTS.md), which is the authority, and do not introduce `.svelte.ts` rune-based state modules or convert existing stores.
- **Build Tool**: [Vite](https://vitejs.dev/)
- **Styling**: [Tailwind CSS v4](https://tailwindcss.com/)
- **Language**: [TypeScript](https://www.typescriptlang.org/)
- **Testing**: [Playwright](https://playwright.dev/) (E2E) & [Vitest](https://vitest.dev/) (Unit)

---

## 📁 Directory Structure

```text
web/
├── e2e/                # Playwright End-to-End test suites
│   ├── apps/           # Individual app E2E tests (Admin, Bank, Blabber, Calculator, Camera, Contacts, Mail, Messages, Notes, Phone, Photos, Settings, Sound, Store)
│   ├── app-residency.spec.ts
│   ├── deep-link.spec.ts
│   ├── display.spec.ts
│   ├── defects.spec.ts
│   ├── error_boundary.spec.ts
│   ├── keybinds.spec.ts
│   ├── navigation.spec.ts
│   ├── notifications.spec.ts
│   └── nui.spec.ts
├── src/
│   ├── apps/           # One directory per app (admin, bank, blabber, calculator, camera, contacts, mail, messages, notes, phone, photos, settings, store)
│   ├── shell/          # The OS itself: Shell.svelte, PhoneFrame, Launcher, ToastHost, VolumeHud, ErrorBoundary
│   │   └── state/      # State the phone owns (navigation, keybinds, registry, bootstrap, devtools, charge, display, signal, time, audio, toast, appEvents)
│   ├── services/       # Client-side cache of each server service (account, admin, blabber, call, camera, contacts, conversations, mail, notes, photos, reports)
│   │                   # plus the two factories they are built from: createCrudStore, createPagedStore
│   ├── sdk/            # @gphone/sdk — the only thing apps may import
│   │   └── ui/         # UI primitives and icons apps build with
│   ├── nui/            # The bridge: transport adapters, fetchNui, useNuiEvent, browser mocks
│   ├── lib/            # Helpers with no gPhone state and no I/O (debug, dragScroll, errors, filterByQuery, formatters, isBrowser, markdown, useScrollDetect)
│   └── main.ts         # Mounts shell/Shell.svelte
├── package.json
└── playwright.config.ts
```

---

## 🧪 Testing Operations

gPhone includes a full suite of automated unit (Vitest) and Playwright End-to-End (E2E) tests.

### Running Unit Tests

Run unit test suites covering the service caches (`account`, `admin`, `call`, `camera`, `contacts`, `conversations`, `mail`, `notes`, `photos`, `reports`) and the `createCrudStore` factory behind them, shell state (`bootstrap`, `charge`, `keybinds`, `navigation`, `registry`, `signal`, `time`, `audio`, `toast`, `appEvents`), transport adapters, SDK helpers and boundaries, and the pure helpers in `lib/`:

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
