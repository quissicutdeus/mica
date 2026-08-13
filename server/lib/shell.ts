import { registerService } from './services';

/**
 * The shell service — the phone itself, rather than any app on it.
 *
 * It has no endpoint because nothing calls into it: the traffic goes one way, from the
 * server out to a player's UI. It is still a service, and declaring it here is what lets
 * `eventNames.test.ts` check the `<service>` segment against a registry instead of a
 * hard-coded list of names that were "not apps".
 */
const SHELL_SERVICE = registerService('shell');

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

/**
 * Tell a freshly loaded character's phone to re-read everything the shell bootstraps.
 *
 * The CEF page loads at resource start and never unloads (AGENTS.md §8), so a player who
 * switches character without a resource restart keeps the previous character's citizenid,
 * balance, admin flag, unread counts and every app's `preload()`-populated store on screen.
 * `server/services/Settings.ts` solved this for settings alone; this is the same push at
 * the shell level, for the bootstrap state nothing else re-reads on its own.
 */
export const pushRehydrate = (source: number): void => {
  emitNet(`gphone:client:${SHELL_SERVICE}:rehydrate`, source);
};

const sourceOf = (player: unknown): number | undefined =>
  typeof player === 'number'
    ? player
    : (player as { PlayerData?: { source?: number } })?.PlayerData?.source;

/**
 * Mirrors `Settings.ts` and `Battery.ts`, including listening for both cores' events,
 * because the shape of the player-loaded event differs between QBCore and qbx and neither
 * is safe to assume. Kept here rather than duplicated a third time, since the push itself
 * is shell-scoped rather than owned by any one app's data.
 */
on('QBCore:Server:OnPlayerLoaded', (player: unknown) => {
  const src = sourceOf(player);
  if (src) pushRehydrate(src);
});

on('qbx_core:server:playerLoaded', (player: unknown) => {
  const src = sourceOf(player);
  if (src) pushRehydrate(src);
});
