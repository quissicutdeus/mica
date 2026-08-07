// The client half of the signal service.

interface DeadZone {
  id: number;
  x: number;
  y: number;
  z: number;
  radius: number;
  level: number;
}

const FULL_SIGNAL = 4;

/**
 * How often the player's position is checked against the zones.
 *
 * Two seconds, not a tick. Bars are ambient information — nobody watches them change —
 * and a per-tick distance check against every zone is a cost paid forever for an answer
 * that is the same one thousands of times in a row. The early-out below means the usual
 * case, no zones and full global signal, costs nothing at all.
 */
const POLL_MS = 2000;

let globalLevel = FULL_SIGNAL;
let zones: DeadZone[] = [];
let override: number | null = null;
let lastSent = -1;

const sendSignalToNui = (level: number) => {
  // Only on change. The NUI store would ignore a repeat, but the message still crosses the
  // bridge and gets parsed, every two seconds, forever.
  if (level === lastSent) return;
  lastSent = level;
  SendNuiMessage(JSON.stringify({ action: 'setSignal', data: level }));
};

/**
 * Squared distance, deliberately — comparing against `radius * radius` avoids a square
 * root per zone per poll, and the comparison is identical.
 */
const withinSquared = (x: number, y: number, z: number, zone: DeadZone): boolean => {
  const dx = x - zone.x;
  const dy = y - zone.y;
  const dz = z - zone.z;
  return dx * dx + dy * dy + dz * dz <= zone.radius * zone.radius;
};

/**
 * The precedence order, in one place.
 *
 * A per-player override wins outright — it is the tinfoil hat, and it is set *at* a player
 * rather than at the world. Otherwise the global level and every overlapping zone are the
 * **same primitive**: take the lowest. Two mechanisms would drift the first time they
 * disagreed, which is why a city-wide outage is expressed as a global level rather than as
 * a special case.
 */
export const evaluateSignal = (
  x: number,
  y: number,
  z: number,
  rules: { global: number; zones: DeadZone[] },
  playerOverride: number | null
): number => {
  if (playerOverride !== null) return playerOverride;

  let level = rules.global;
  for (const zone of rules.zones) {
    if (zone.level < level && withinSquared(x, y, z, zone)) level = zone.level;
  }
  return level;
};

onNet('gphone:client:signal:rules', (rules: { global: number; zones: DeadZone[] }) => {
  globalLevel = typeof rules?.global === 'number' ? rules.global : FULL_SIGNAL;
  zones = Array.isArray(rules?.zones) ? rules.zones : [];
  // Re-evaluate immediately rather than waiting out the poll: a blackout that takes two
  // seconds to show reads as the script having failed.
  poll();
});

onNet('gphone:client:signal:override', (level: number | null) => {
  override = typeof level === 'number' ? level : null;
  poll();
});

function poll(): void {
  // The early-out. With no zones and full global signal there is nothing a position could
  // change, so the common case never asks the game where the player is.
  if (override === null && zones.length === 0 && globalLevel >= FULL_SIGNAL) {
    sendSignalToNui(FULL_SIGNAL);
    return;
  }

  const [x, y, z] = GetEntityCoords(PlayerPedId(), true) as unknown as number[];
  sendSignalToNui(evaluateSignal(x, y, z, { global: globalLevel, zones }, override));
}

setInterval(poll, POLL_MS);

// The rules are broadcast on change, so a client that joined after the last change would
// otherwise never learn them.
setTimeout(() => TriggerServerEvent('gphone:server:signal:rules'), 1000);
