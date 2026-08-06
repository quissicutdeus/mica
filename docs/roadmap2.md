# Notifications, Network Architecture, and System Honesty

## Context & Overview

A technical proposal and specification addressing four core areas of gPhone's OS architecture:

1. **Registry Warning**: Fixing false collision warnings on clean bundled add-on installs.
2. **Settings Honesty**: Removing unfulfilled wallpaper claims from app manifests until Camera decoupled capture resolution exists.
3. **Network Architecture & Bluetooth Subsystem**: Redefining network preconditions, handling cell dead zones/outages, introducing Bluetooth proximity networking, anti-doxxing privacy controls, and a unified Network Settings UI.
4. **Notifications as an OS Service & Toast Redesign**: OS-level notification persistence, pull-down shade, generic SDK hooks, and a visual layout redesign for notification toasts.

---

## 1. Registry Warning Fix (Small)

### Problem

`web/src/shell/state/registry.ts:158` guards on `resolveComponent(id)`, which falls back to `bundledComponents` (the startup glob of every bundled add-on). Installing a bundled add-on from the Store therefore logs a warning that it _"is already registered and is being replaced"_, which is false and obscures genuine ID collisions.

### Solution

- Guard on whether the `id` is already in the `installed` store map rather than checking the fallback map (`resolveComponent`).
- Add test in `web/src/shell/state/registry.test.ts`: installing a bundled add-on logs no warnings, while registering over an already-installed ID still triggers the warning.

---

## 2. Wallpaper Honesty (Small)

### Problem

`web/src/apps/settings/manifest.ts` advertises wallpaper configuration without underlying feature support in the app.

### Solution

- Update `web/src/apps/settings/manifest.ts` description to remove "wallpapers".
- Document prerequisite in `docs/roadmap.md` under _Proposed, not built_: Image capture is currently tied to on-screen container bounds (`apps/camera/index.svelte` crops `containerRef.getBoundingClientRect()` against `window.innerWidth`/`Height`). Capture resolution must be decoupled from display scale before wallpaper functionality can be implemented cleanly.

---

## 3. Network Architecture & Bluetooth Subsystem (Medium–Large)

### 3a. Cellular Network Redefinition

- **Precondition vs. Disclosure**: Redefine `network` as requiring a live connection to external services or players (e.g. Messages, Blabber, Phone, Store, Bank, Mail). Local-only apps (Notes, Camera, Photos, Calculator, Settings, Admin) operate offline on local data.
- **Dead Zones & Outages**:
  - `shell/state/signal.ts` manages signal levels (0–4 bars).
  - Server maintains outage state and spatial dead zones; game client polls coordinates against dead zones and pushes signal updates.
  - Apps handle 0-bar states gracefully via `fetchNui` default fallbacks and non-crashing error toasts.

### 3b. Bluetooth & Proximity Networking

- **Use Case**: Enables short-range, peer-to-peer data sharing (e.g., contact exchange, local file drops, proximity air-drops) even in areas with zero cell reception or active network outages.
- **Privacy & Anti-Doxxing Model**:
  - _Problem_: Traditional phone systems automatically expose character names or phone identities to nearby players whenever the phone is out, causing accidental self-doxxing.
  - _Solution_: Bluetooth visibility is user-controlled. Turning Bluetooth **OFF** renders the device invisible to proximity scans and blocks unsolicited contact sharing or snooping attempts.
  - _Defaults & Persistence_: Bluetooth defaults to **ON** and remembers the setting across app launches and phone restarts via persistent state storage.

### 3c. Network Settings Group

The Settings app (`web/src/apps/settings/`) will feature a dedicated **Network** settings group containing:

- **Cell Service Toggle**: Controls cellular network connection (gating network-dependent apps when turned off).
- **Bluetooth Toggle**: Controls short-range Bluetooth discovery and proximity features (defaults to **ON**, saved persistently).

---

## 4. Notifications as an OS Service & Toast Redesign (Substantial)

### 4a. Standardized Notification Toast UI

Notification toasts rendered by `ToastHost.svelte` follow a clear visual hierarchy:

- **App Icon**: Visual icon of the source application on the left.
- **App Name**: Rendered in a smaller, subtle header font.
- **Primary Header (Stronger/Bolder Font)**: Contextually relevant title/sender with strong font weight (e.g., Contact/Sender Name for Messages/Calls, Email Sender for Mail, Name of person sharing a contact over Bluetooth).
- **Body Content**: Regular weight text for message snippet, email subject/preview, or request details below the primary header.

### 4b. Persistent Notification Schema & Service

- **Service**: `server/services/Notifications.ts` via `defineService`.
- **Access**: `{ read: 'owner', write: 'server' }`. Rows are server-generated; players can clear (soft-delete) their own rows.
- **Columns**: `app` (varchar 32, clientFilterable), `kind` (varchar 32), `title` (varchar 80), `body` (varchar 255), `avatar` (varchar 255, nullable), `deep_link` (text, nullable), `read_at` (nullable), `cleared_at` (nullable).
- **Indexing**: `(citizenid, cleared_at, id)` for the shade, `(citizenid, app, id)` for per-app tabs, `(citizenid, read_at)` for unread badges.
- **Retention**: Convar `gphone_notification_retention` (in days) prunes stale notification rows on resource start.

### 4c. Notification Delivery & Write Path

- Extend `server/lib/appEvents.ts` so `push` carrying `{ notify: true }` persists rows asynchronously regardless of whether the recipient is currently online.
- Synchronous `PushOutcome` preserved; single multi-row batch insert for `pushMany`.

### 4d. SDK & Client State

- Hook: `useNotifications(appId?)` providing paged notification items, unread count by app, `markRead`, `clear`, `clearAll`.
- Service Store: `web/src/services/notifications.ts` with module-scoped subscriptions.
- `usePhoneNotification` remains for ephemeral non-persisted UI feedback (e.g., "Copied to clipboard").

### 4e. Notification Shade UI

- `web/src/shell/NotificationShade.svelte` + `web/src/shell/state/notifications.ts`.
- Drag down from status bar to open; swipe rows left/right to soft-clear to history; tapping a row routes via `deepLink` and marks as read.
- Reclaims `back` keybind while open. Accounts for display scale (`transform: scale()`) via direct element measurement.

### 4f. App Integration (Blabber, Messages, Contacts)

- Blabber Notifications tab consumes `useNotifications('blabber')`.
- Generalize server pushes for mentions, follows, replies, DMs, contact share requests, and incoming emails.

---

## Sequencing & Plan of Execution

1. **Phase 1: Housekeeping & Honesty**: Registry warning fix, wallpaper description update, network permission docs update.
2. **Phase 2: Network & Bluetooth Subsystem**: Network settings group UI with Cell Service and Bluetooth toggles; Bluetooth state persistence; proximity privacy/anti-doxxing controls.
3. **Phase 3: Notifications Data Layer**: Server table, `appEvents.ts` persistence, and SDK hook `useNotifications`.
4. **Phase 4: Notification Toast UI & Shade**: Re-designed toast component matching standard hierarchy + Notification Shade component and gestures.
5. **Phase 5: App Integration**: Blabber tab refactor, Messages/Contact Sharing toast & notification updates.

---

## Verification Plan

- Run full verification suite: `pnpm verify` (format, typecheck, unit, e2e, build, deadcode).
- **Unit Tests**:
  - `server/__tests__/notifications.test.ts`: Permissions, paging, unread batching.
  - `server/__tests__/appEvents.test.ts`: Offline persistence, non-blocking writes.
  - `server/__tests__/routes.test.ts`: Route declarations and handler coverage.
  - `web/src/shell/state/registry.test.ts`: Warning suppression on bundled add-on installs.
  - `web/src/sdk/permissions.test.ts`: Verification of network declarations.
- **E2E & UI Verification**:
  - `web/e2e/notifications.spec.ts`: Toast visual hierarchy, shade drag/swipe gestures, deep-link navigation.
  - Verify Bluetooth toggle state persistence in Settings and proximity discovery blocking when turned off.
  - Test CEF 103 compatibility in FiveM.
