import { get } from 'svelte/store';
import { usePersisted } from '../../sdk/hooks/usePersisted';
import { fetchSettings } from '../../services/settings';

/** Shown near the dock until the App Drawer has been opened once, then gone for good. */
export const appDrawerHintSeen = usePersisted<boolean>('settings', 'appDrawerHintSeen', false);

export function markAppDrawerHintSeen(): void {
  if (!get(appDrawerHintSeen)) appDrawerHintSeen.set(true);
}

/**
 * A character who already had settings before this hint shipped never earned an
 * explicit "seen" row, but they've long since discovered the drawer on their own —
 * showing them a first-run hint would be a false first run. Call once at boot, after
 * `hydrateSettings` has had a chance to apply any real `appDrawerHintSeen` row from the
 * server, so this only fires for a character with none.
 */
export async function migrateAppDrawerHintForExistingSaves(): Promise<void> {
  if (get(appDrawerHintSeen)) return;
  const rows = await fetchSettings();
  const hasOtherSettings = rows.some(
    (row) => !(row.app === 'settings' && row.setting_key === 'appDrawerHintSeen')
  );
  if (hasOtherSettings) appDrawerHintSeen.set(true);
}
