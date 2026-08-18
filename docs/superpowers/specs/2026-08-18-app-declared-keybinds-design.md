# App-declared default hotkeys, grouped in Settings > Shortcuts

MICA-9

## Background

`shared/keybinds.ts` is a flat, core-only list of keybind actions — only `core: true`
apps can add entries to it (same restriction as `shared/routes.ts`), and Settings >
Shortcuts renders every action as one flat list, not grouped by owning app. Camera's
shutter is scoped with `when: 'app:camera'` but still shows flat alongside phone-wide
actions like "Put Phone Away."

Discovered while designing Snek (MICA-8), which ships using a scoped raw `keydown`
handler rather than waiting on this. This ticket tracks the general OS capability as a
follow-up.

## Goal

Let any app — including `core: false` add-ons — declare its own default hotkeys via its
manifest, and have Settings > Shortcuts render them grouped under their owning app
rather than as one flat list. Existing rebind/conflict-detection machinery
(`useKeybinds`, `shell/state/keybinds.ts`) keeps working unchanged for both core and
app-declared actions.

## Design

### 1. Manifest extension — `web/src/sdk/manifest.ts`

Add an optional field to `AppManifest`/`AppManifestInput`:

```ts
export interface AppKeybindInput {
  /** Unique within this app. Namespaced automatically to `${appId}:${id}`. */
  id: string;
  /** Shown in Settings > Shortcuts. */
  label: string;
  defaultKey: string;
}

// on AppManifest / AppManifestInput
keybinds?: AppKeybindInput[];
```

Deliberately no `scope` or `when` on the author-facing type. An app-declared bind is
always phone-scope (game-scope requires `RegisterKeyMapping`, which only core system
binds use) and always eligible only while that app is foreground — auto-derived by the
aggregator as `when: 'app:${appId}'`. This closes off an app claiming an unscoped action
or another app's context by construction, rather than by convention.

`defineApp` does no special validation of `keybinds` beyond what TypeScript already
enforces — duplicate `id`s within one app's list are an authoring bug the app owner will
notice immediately (both hotkeys shown, only one wins the rebind slot), not something
worth a runtime throw.

### 2. Runtime aggregation — `web/src/shell/state/keybinds.ts`

Today `bindings`, `resolveAction`, and `dispatchKey` all read the static
`PHONE_SCOPE_ACTIONS` export from `shared/keybinds.ts`. Replace that with a derived
store combining core actions with app-declared ones pulled from `appRegistryStore`
(live, installed apps only — an uninstalled add-on's binds shouldn't occupy a key slot
or show in Shortcuts):

```ts
interface ResolvedKeybindAction extends KeybindAction {
  /** 'core' for the static list, otherwise the owning app's id. */
  ownerId: string;
  /** Display header for Shortcuts grouping — 'Phone' for core. */
  ownerLabel: string;
}

const appActions = derived(appRegistryStore, ($apps) =>
  $apps.flatMap((app) =>
    (app.keybinds ?? []).map(
      (kb): ResolvedKeybindAction => ({
        id: `${app.id}:${kb.id}`,
        label: kb.label,
        defaultKey: kb.defaultKey,
        scope: 'phone',
        when: `app:${app.id}`,
        ownerId: app.id,
        ownerLabel: app.name
      })
    )
  )
);

const allPhoneActions = derived(appActions, ($appActions) => [
  ...PHONE_SCOPE_ACTIONS.map((a) => ({ ...a, ownerId: 'core', ownerLabel: 'Phone' })),
  ...$appActions
]);
```

`bindings` derives from `[overrides, allPhoneActions]` instead of the static
`KEYBIND_ACTIONS` (app-declared actions need a resolved default key too).
`resolveAction`/`dispatchKey` filter over `get(allPhoneActions)` instead of the static
import. The precedence ranking in `resolveAction` (call > app > unscoped) is unchanged —
an app-declared action ranks as `app:` scoped exactly like `shutter` does today.

`GAME_SCOPE_ACTIONS` and core-only concerns (`openPhone`'s `RegisterKeyMapping`) are
untouched; this only ever affects the phone-scope dispatch path.

### 3. Conflict detection — `shared/keybinds.ts`

`conflictsWith(action, key, bindings)` currently closes over the module-level
`PHONE_SCOPE_ACTIONS` constant to search for a collision. Parametrize it to accept the
candidate list explicitly:

```ts
export function conflictsWith(
  action: KeybindAction,
  key: string,
  bindings: Record<string, string>,
  candidates: readonly KeybindAction[] = PHONE_SCOPE_ACTIONS
): KeybindAction | undefined
```

The default preserves every existing caller/test that doesn't pass a fourth argument.
`useKeybinds().findConflict` passes `get(allPhoneActions)` so a rebind is checked against
every live action, core and app-declared alike.

### 4. `useKeybinds()` hook — `web/src/sdk/hooks/useKeybinds.ts`

`actions` changes from a static array to a reactive, grouped store:

```ts
export interface KeybindGroup {
  ownerId: string;
  ownerLabel: string;
  actions: ResolvedKeybindAction[];
}

/** Core first, then one section per app with declared binds, alphabetical by ownerLabel. */
groups: Readable<KeybindGroup[]>;
```

This replaces the flat `actions` array in the hook's return value (no other consumer of
`useKeybinds().actions` exists today besides `Shortcuts.svelte`, confirmed by grep).
`findConflict` is unchanged in signature, just backed by the live combined list.

### 5. UI — `web/src/apps/settings/panes/Shortcuts.svelte`

Replace the single `{#each actions as action}` flat list with a nested loop over
`$groups`, each group rendered under a small section header (reusing the existing
`divide-y` row styling within each group). Core's group renders without a visible label
(today's flat list is implicitly "the phone's own shortcuts"); each app group is headed
by `ownerLabel`. Capture/rebind/reset/conflict-toast logic is untouched — it already
operates on `action.id`, which stays unique.

## Testing

- `shared/keybinds.test.ts` (new): `conflictsWith` with an explicit `candidates` list
  finds a collision against an app-declared action; omitting it still checks only core
  actions (back-compat).
- `web/src/shell/state/keybinds.test.ts`: extend with a case registering a fake app
  manifest with `keybinds` into `appRegistryStore` and asserting `resolveAction` finds
  the app-declared action ID when eligible, and does not find it when another app is
  foreground.
- Manual: add a temporary `keybinds` entry to one add-on manifest (e.g. Notes) during
  development to confirm Settings > Shortcuts renders a grouped section and rebinding
  works; remove before landing unless MICA-8/Snek wants to be the first real consumer.

## Out of scope

- Game-scope (`RegisterKeyMapping`) app-declared binds — every app-declared bind is
  phone-scope only, matching the ticket's "Settings > Shortcuts" framing.
- Migrating Snek (MICA-8) or the calculator off their existing raw `keydown` handlers
  onto this — explicitly deferred by MICA-8's scope note.
