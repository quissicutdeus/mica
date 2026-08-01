import { registerService } from './services';

/**
 * The shell service — the phone itself, rather than any app on it.
 *
 * It has no endpoint because nothing calls into it: the traffic goes one way, from the
 * server out to a player's UI. It is still a service, and declaring it here is what lets
 * `eventNames.test.ts` check the `<service>` segment against a registry instead of a
 * hard-coded list of names that were "not apps".
 */
export const SHELL_SERVICE = registerService('shell');

export interface ShellNotification {
  type?: 'success' | 'error' | 'info' | 'warning';
  title?: string;
  message: string;
}

/**
 * Raise a toast on a player's phone.
 *
 * Replaces the same `emitNet('gphone:client:shell:notify', ...)` written out at five call
 * sites across four files. The event name is derived from the service id in exactly one
 * place, so it cannot drift from what the client listens for.
 */
export const notifyPlayer = (source: number, notification: ShellNotification): void => {
  if (!notification?.message) return;
  emitNet(`gphone:client:${SHELL_SERVICE}:notify`, source, notification);
};
