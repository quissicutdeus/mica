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
  // Dual-purpose in FiveM: indexed to reach another resource (`exports['qbx_core']`)
  // and called to publish one (`exports('SendSystemEmail', fn)`). A function covers
  // both, since a function is also an object.
  //
  // Caveat worth knowing: Vite's module wrapper supplies its own non-callable
  // `exports` binding in module scope, which shadows this global. So the indexed use
  // resolves against Vite's object and the callable use does NOT reach this stub —
  // which is why MailController guards its `exports(...)` call with a typeof check.
  exports: function () {},
  onNet: noop,
  emitNet: noop,
  on: noop,
  onNetSafe: noop,
  source: 0,
  GetCurrentResourceName: () => 'gphone',
  RegisterCommand: noop,
  // Denies by default, so a suite that forgets to stub it cannot accidentally exercise
  // the privileged path.
  IsPlayerAceAllowed: () => false
};

for (const [key, value] of Object.entries(fivemGlobals)) {
  if ((globalThis as Record<string, unknown>)[key] === undefined) {
    (globalThis as Record<string, unknown>)[key] = value;
  }
}
