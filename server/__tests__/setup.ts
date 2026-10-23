// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * FiveM server runtime stubs.
 *
 * Server modules reach for these globals at import time — `Database` reads
 * `exports.oxmysql` in module scope, services call `onNet` while registering —
 * so they have to exist before the module graph loads. Individual suites override
 * `onNet` / `emitNet` / `source` to capture and drive the handlers under test.
 */
import { beforeAll, beforeEach } from 'vitest';
import { installTestPhone } from './phoneStub';

const noop = () => {};

const oxmysqlStub = {
  query_async: noop,
  insert_async: noop,
  update_async: noop,
  scalar_async: noop,
  single_async: noop,
  transaction_async: noop
};

const exportsFn = function () {};
(exportsFn as any).oxmysql = oxmysqlStub;

const fivemGlobals: Record<string, unknown> = {
  exports: exportsFn,
  onNet: noop,
  emitNet: noop,
  on: noop,
  onNetSafe: noop,
  source: 0,
  GetCurrentResourceName: () => 'mica',
  GetInvokingResource: () => 'test-resource',
  RegisterCommand: noop,
  GetConvar: (_name: string, fallback: string) => fallback,
  GetConvarInt: (_name: string, fallback: number) => fallback,
  IsPlayerAceAllowed: () => false
};

for (const [key, value] of Object.entries(fivemGlobals)) {
  if ((globalThis as Record<string, unknown>)[key] === undefined) {
    (globalThis as Record<string, unknown>)[key] = value;
  }
}

/**
 * Which phone a device-owned request is for, when no suite has said (MICA-282). See
 * `phoneStub.ts`. Installed at load *and* before every test, because importing a service that
 * pulls `services/Devices.ts` in — Conversations does, for its handover hook — installs the real
 * resolvers at import time, and the real ones read `mica_devices`, which no mocked suite seeds.
 * A suite about the resolution itself calls `deviceForRequest` from `services/Devices.ts`
 * directly rather than through the seam.
 */
installTestPhone();
beforeEach(() => {
  installTestPhone();
});

/**
 * No service interval survives import.
 *
 * Signal, Battery, Music, Invoices and HodlrMarket each start a real `setInterval` at module
 * scope, and a suite that imports them against stubbed bridges (`reachability.test.ts` imports
 * every service) then has a live timer firing at the stub. On a slow runner a case outlasts the
 * 2 s poll and the tick throws inside a timer callback — Vitest reports it as an unhandled error
 * and fails a run in which every assertion passed.
 *
 * Collection is when module scope runs, so an interval created before the first `beforeAll` is
 * dropped: it returns a handle (so a `clearInterval` on it is harmless) and schedules nothing.
 * Intervals a suite starts itself, or from a re-import inside a test, are real, and fake timers
 * installed later wrap this function rather than being wrapped by it. Each service exposes its
 * tick as a test seam (`pollSignal`, `tickBattery`), which is how a suite drives one.
 */
const realSetInterval = globalThis.setInterval;
let collecting = true;
globalThis.setInterval = ((handler: unknown, ms?: number, ...args: unknown[]) =>
  collecting
    ? realSetInterval(() => {}, 2 ** 31 - 1).unref()
    : (realSetInterval as Function)(handler, ms, ...args)) as typeof setInterval;
beforeAll(() => {
  collecting = false;
});
