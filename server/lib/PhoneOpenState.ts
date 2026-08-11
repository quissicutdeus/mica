import { guardNetEvent } from './netGuard';

/**
 * Whether a player's phone is open right now, mirrored from the client.
 *
 * There is no way to ask a client synchronously — `SetNuiFocus`, the animation state and
 * `PhoneState.isOpen()` all live only on their machine, and this codebase has no
 * server-initiated round trip to ask and wait (see `shared/rpc.ts`, which is NUI-to-server
 * only). So this is fed the same way Signal and Battery are: a fire-and-forget push
 * whenever the client's own state changes, cached here, and `IsPhoneOpen` answers from
 * the last value pushed rather than asking fresh.
 *
 * That makes it eventually-consistent rather than live — a push in flight when a caller
 * asks reads one state behind for a moment — which is the same trade-off `describeSignalFor`
 * already makes and the right one here too.
 */
const open = new Map<number, boolean>();

/** For the `IsPhoneOpen` export. Defaults to closed for a source never heard from. */
export const isPhoneOpen = (source: number): boolean => open.get(source) ?? false;

onNet('gphone:server:shell:setOpen', (isOpen: unknown) => {
  const player = guardNetEvent('shell', 'setOpen');
  if (!player) return;
  open.set(source, isOpen === true);
});

on('playerDropped', () => {
  // FiveM reuses server ids, so a stale `true` left behind would tell the next player's
  // caller their phone is open before they have ever pressed a key.
  open.delete(source);
});
