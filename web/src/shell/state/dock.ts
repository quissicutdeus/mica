import { usePersisted } from '../../sdk/host/usePersisted';

export const DOCK_SLOT_COUNT = 4;

/** Phone, Messages, Media, Camera — the ids are directory names under `web/src/apps/`. */
export const DEFAULT_DOCK_APP_IDS = ['phone', 'messages', 'media', 'camera'];

/**
 * Exactly four entries, positionally significant — index *is* the slot. An empty string
 * marks an unconfigured slot rather than shrinking the array, so slot 2 stays slot 2 even
 * if slot 0 and 1 are unset; `Dock.svelte` renders a placeholder for an empty entry.
 *
 * Does *not* filter a non-empty id against the app registry's known ids: the registry's
 * add-on half rehydrates asynchronously (`registry.ts`'s `installedAddOnIds` subscription),
 * so a sanitizer that ran before that finished would permanently strip a valid dock id it
 * hadn't learned about yet. `Dock.svelte` skips rendering a slot whose id resolves to no
 * manifest instead — the same tolerance `Shell.svelte` already gives an app whose component
 * hasn't loaded.
 */
export function sanitizeDockAppIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [...DEFAULT_DOCK_APP_IDS];
  const strings = value.filter((v): v is string => typeof v === 'string');
  const seen = new Set<string>();
  const deduped = strings.map((id) => {
    if (id === '' || seen.has(id)) return '';
    seen.add(id);
    return id;
  });
  const slots = deduped.slice(0, DOCK_SLOT_COUNT);
  while (slots.length < DOCK_SLOT_COUNT) slots.push('');
  return slots;
}

export const dockAppIds = usePersisted<string[]>('settings', 'dockAppIds', DEFAULT_DOCK_APP_IDS, {
  sanitize: sanitizeDockAppIds
});

/** Replaces one slot outright — used when an app is dragged onto the dock. */
export function setDockSlot(index: number, appId: string): void {
  if (index < 0 || index >= DOCK_SLOT_COUNT) return;
  dockAppIds.update((current) => {
    const next = sanitizeDockAppIds(current);
    // The app may already occupy another slot; dragging it onto a new one moves it rather
    // than duplicating it across two slots.
    const previousIndex = next.indexOf(appId);
    if (previousIndex !== -1) next[previousIndex] = '';
    next[index] = appId;
    return next;
  });
}
