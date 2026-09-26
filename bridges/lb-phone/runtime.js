// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Registers one side of a bridge's table as this resource's exports (MICA-232).
 *
 * Byte-identical in every bridge -- `server/__tests__/bridges.test.ts` holds that -- because
 * each bridge is a resource an owner copies on its own, and a resource cannot load a file
 * from outside its own directory.
 *
 * Loaded as a `shared_script` after `map.js`. FiveM runs every script of a resource side in
 * one JavaScript context, so what `map.js` put on `globalThis` is here, and what this puts
 * there is visible to `server.js` and `client.js`. No `require`, no modules: the client
 * runtime has neither.
 *
 * Nothing here throws into the caller. A mapped call that fails answers the value the
 * original resource answers on failure (its entry's `fallback`) and logs why; a name with no
 * micaOS equivalent logs once, saying what to use instead, and answers the same way.
 */
globalThis.micaBridgeRegister = (bridge, side) => {
  const warned = new Set();
  const warnOnce = (key, message) => {
    if (warned.has(key)) return;
    warned.add(key);
    console.warn(`[${bridge.resource} bridge] ${message}`);
  };

  const call = `exports['${bridge.resource}']`;

  const stub = (entry) => () => {
    warnOnce(
      entry.name,
      `${call}:${entry.name} is not supported by micaOS and did nothing. ${entry.note}`
    );
    return entry.fallback;
  };

  const forward = (entry) => {
    const failed = (error) => {
      const reason = error && error.message ? error.message : String(error);
      warnOnce(`${entry.name}\n${reason}`, `${call}:${entry.name} failed: ${reason}`);
      return entry.fallback;
    };
    return (...args) => {
      try {
        const result = entry.run(exports.mica, ...args);
        return result && typeof result.then === 'function' ? result.catch(failed) : result;
      } catch (error) {
        return failed(error);
      }
    };
  };

  for (const entry of bridge.entries) {
    if (entry.side !== side) continue;
    exports(entry.name, entry.uses.length === 0 ? stub(entry) : forward(entry));
  }
};
