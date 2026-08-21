import { usePersisted } from '../../sdk/host/usePersisted';

/**
 * Persistent user settings for OS notifications.
 */
export const toastsEnabled = usePersisted<boolean>('settings', 'toastsEnabled', true);
export const notificationSoundEnabled = usePersisted<boolean>(
  'settings',
  'notificationSoundEnabled',
  true
);
export const badgesEnabled = usePersisted<boolean>('settings', 'badgesEnabled', true);
