---
name: persisted-default-must-not-persist
description:
  usePersisted's outer set() always writes storage AND queues a debounced server
  save — never use it to apply a runtime default; overlay with a derived store
  instead
metadata:
  type: project
---

`web/src/host/facets/persisted.ts`'s `usePersisted` store has two `set`s: the
outer one it returns (persists — `appStorage.setItem` then
`web/src/host/settingsSync.ts`'s `queueWrite`, a 400ms-debounced save to the
server) and an inner one used only by `registerPersistedReset`/
`registerPersistedRehydrate` (updates in-memory only, never persists).

A caller outside `persisted.ts` only ever has the outer one. So "fill this
persisted store with a fallback default when nothing is saved yet" must never
call that store's own `.set()` — it looks like the obvious move (and is what
`web/src/shell/state/dock.ts` did for MICA-234's owner-configured default dock)
but it both writes the fallback into storage as if the player had chosen it, and
queues a real server save. The save is timing-dependent: if a settings rehydrate
(`web/src/host/facets/storage.ts`'s `hydrateSettingsInProcess`, itself
debounce-free) lands **after** the queued save fires, the queued save clobbers
whatever the rehydrate just restored.

Fix: keep the real persisted store private to the module, and export a `derived`
overlay that recomputes `fallback vs. saved` from the store's current value plus
whatever signals "nothing saved yet" (e.g. a raw storage-key presence check), on
every change of either input. Never write the fallback into the store. See
`dock.ts`'s `dockOverlay` for the worked example — it also had to move
`setDockSlot` to build its next value from `get(dockAppIds)` (the overlay, i.e.
what the player actually sees) rather than the raw saved store, since a player
dragging onto a slot is acting on what's on screen.

**Why:** found reviewing MICA-234's dock-default fix — Rex flagged that the
naive `ownerConfig.subscribe(() => dockAppIds.forDevice('phone').set(...))`
could overwrite a player's real dock on the server depending on race order
between `shell:ownerConfig` and the settings rehydrate, and that a stale
per-character local cache made it worse.

**How to apply:** any future "owner/server default that should show until the
player's own value arrives" (not just docks) should reach for this overlay
pattern rather than a one-shot write into a `usePersisted` store.
