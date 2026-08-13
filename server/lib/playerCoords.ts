/**
 * Where a connected player is right now, or `null`.
 *
 * Guarded because these natives do not exist outside the FiveM server runtime, and this
 * module is imported by the SQL codegen and by tests.
 *
 * `GetPlayerPed` can hand back a non-zero handle for a player whose ped is not yet synced
 * server-side — the window right around `QBCore:Server:OnPlayerLoaded` — so `!ped` alone
 * does not catch it. `GetEntityCoords` throws a native argument error on a handle like
 * that rather than returning something falsy, and both existing callers run this inside a
 * loop (`Signal.ts`'s `pollSignal` interval, `proximity.ts`'s nearby-player scan), so an
 * uncaught throw here would abort every player after the failing one. `DoesEntityExist` is
 * the same guard `client/game/PhoneCamera.ts` already uses before trusting a ped handle.
 *
 * Extracted once a third caller (`Photos.ts`'s `shareLocation`) needed the identical
 * guard — two copies were a duplication worth living with, a third was not.
 */
export const playerCoords = (src: number): [number, number, number] | null => {
  if (
    typeof GetPlayerPed !== 'function' ||
    typeof GetEntityCoords !== 'function' ||
    typeof DoesEntityExist !== 'function'
  ) {
    return null;
  }
  const ped = GetPlayerPed(String(src));
  if (!ped || !DoesEntityExist(ped)) return null;
  const coords = GetEntityCoords(ped) as unknown as number[];
  return coords && coords.length >= 3 ? [coords[0], coords[1], coords[2]] : null;
};
