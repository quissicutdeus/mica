/**
 * FiveM server runtime stubs.
 *
 * Server modules reach for these globals at import time — `Database` reads
 * `exports.oxmysql` in module scope, controllers call `onNet` while registering —
 * so they have to exist before the module graph loads. Individual suites override
 * `onNet` / `emitNet` / `source` to capture and drive the handlers under test.
 */
const noop = () => {};

const fivemGlobals: Record<string, unknown> = {
  exports: {},
  onNet: noop,
  emitNet: noop,
  on: noop,
  onNetSafe: noop,
  source: 0,
  GetCurrentResourceName: () => 'gphone'
};

for (const [key, value] of Object.entries(fivemGlobals)) {
  if ((globalThis as Record<string, unknown>)[key] === undefined) {
    (globalThis as Record<string, unknown>)[key] = value;
  }
}
