// The client half of the signal service.

/**
 * Display only.
 *
 * This used to hold the zone list, poll the player's position against it every two seconds
 * and decide its own bars. That was fine while nothing read the level — a faked signal drew
 * four bars in a tunnel and nothing else. It stops being fine the moment an app degrades at
 * zero bars, because a client deciding its own bars is a client deciding whether it is in a
 * dead zone.
 *
 * The server evaluates now and pushes a whole number when it changes. This half forwards it
 * to the NUI and knows nothing about zones, which is the point: a client that cannot see
 * them cannot decide it is outside one.
 */
onNet('gphone:client:signal:set', (level: unknown) => {
  const bars = Number(level);
  if (!Number.isFinite(bars)) return;

  SendNuiMessage(
    JSON.stringify({
      action: 'setSignal',
      data: Math.max(0, Math.min(4, Math.round(bars)))
    })
  );
});
