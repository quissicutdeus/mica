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
import { beforeEach } from 'vitest';
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
 * pulls `services/Phones.ts` in — Conversations does, for its handover hook — installs the real
 * resolvers at import time, and the real ones read `mica_phones`, which no mocked suite seeds.
 * A suite about the resolution itself calls `phoneForRequest` from `services/Phones.ts`
 * directly rather than through the seam.
 */
installTestPhone();
beforeEach(() => {
  installTestPhone();
});
