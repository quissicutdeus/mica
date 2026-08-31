import { usePersisted } from '../../../../sdk/host/usePersisted';

/**
 * Flashlight quick-toggle state, phone-only for now — no game-world light source yet.
 * Defaults to OFF and persists across reloads, same shape as `bluetooth.ts`.
 */
export const flashlightEnabled = usePersisted('settings', 'flashlight_enabled', false);

export const toggleFlashlight = (): void => flashlightEnabled.update((v) => !v);
export const setFlashlightEnabled = (enabled: boolean): void => flashlightEnabled.set(enabled);
