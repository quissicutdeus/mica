// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The server half: every server entry in `map.js`, plus the relay that lets a client-side
 * `CreateCall` reach micaOS's server-only `CreateCall(source, number)`.
 *
 * The relay is a net event, so any client can emit it -- which lets a player dial a number,
 * something the phone already lets them do. It dials only as the sender (`source`), never as
 * anyone else, and at most once every two seconds per player, because micaOS's own dial
 * route carries a rate limit this path would otherwise step around.
 */
(() => {
  const bridge = globalThis.micaBridge;
  globalThis.micaBridgeRegister(bridge, 'server');

  const CALL_COOLDOWN_MS = 2000;
  const lastCall = new Map();

  onNet(bridge.callEvent, (number) => {
    const src = Number(source);
    if (!Number.isInteger(src) || src <= 0) return;
    if (typeof number !== 'string' || !number.trim() || number.length > 20) return;
    const now = Date.now();
    if (now - (lastCall.get(src) ?? -Infinity) < CALL_COOLDOWN_MS) return;
    lastCall.set(src, now);
    Promise.resolve()
      .then(() => exports.mica.CreateCall(src, number))
      .catch((error) => console.warn(`[${bridge.resource} bridge] CreateCall failed:`, error));
  });

  on('playerDropped', () => lastCall.delete(Number(source)));
})();
