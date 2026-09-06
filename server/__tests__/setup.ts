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
  IsPlayerAceAllowed: () => false
};

for (const [key, value] of Object.entries(fivemGlobals)) {
  if ((globalThis as Record<string, unknown>)[key] === undefined) {
    (globalThis as Record<string, unknown>)[key] = value;
  }
}
