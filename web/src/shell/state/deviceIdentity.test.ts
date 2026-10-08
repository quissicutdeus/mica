// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
// `lockScreen.ts` reads a persisted setting at import, so this stands in for the shell.
import '../../host/registerFacets';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

/**
 * The transport, by contract action: each `lockscreen:status` waits on a promise this file
 * resolves by hand, so a test can look at the lock while the new device's answer is still
 * out — the window the ticket is about.
 */
const { calls, pendingStatus } = vi.hoisted(() => ({
  calls: [] as { id: string; action: string; device?: string }[],
  pendingStatus: [] as { device?: string; resolve: (v: { hasPasscode: boolean }) => void }[]
}));
vi.mock('../../nui/call', () => {
  const answer = (contract: { id: string }, action: string, device?: string) => {
    calls.push({ id: contract.id, action, device });
    if (contract.id === 'lockscreen' && action === 'status') {
      return new Promise((resolve) => pendingStatus.push({ device, resolve }));
    }
    if (contract.id === 'settings' && action === 'getAll') return Promise.resolve([]);
    return Promise.resolve(true);
  };
  return {
    call: vi.fn((contract, action, _input, options?: { device?: string }) =>
      answer(contract, action, options?.device)
    ),
    callOr: vi.fn((contract, action, _input, _d, options?: { device?: string }) =>
      answer(contract, action, options?.device)
    )
  };
});
const { bootstrapStores, resetBootstrapState } = vi.hoisted(() => ({
  bootstrapStores: vi.fn(() => Promise.resolve()),
  resetBootstrapState: vi.fn()
}));
vi.mock('./bootstrap', () => ({ bootstrapStores, resetBootstrapState }));

import { installDeviceIdentity } from './deviceIdentity';
import { setActiveDevice } from './device';
import { openDevice } from './phoneOpen';
import { autoLockPolicy, evaluateLockOnOpen, isLocked } from './lockScreen';
import { hasPasscode, passcodeAnswerFor } from '../../services/passcode';

/** Let every settled promise run its continuation. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const answerStatus = async (hasCode: boolean) => {
  const next = pendingStatus.shift();
  expect(next, 'a lockscreen:status request is out').toBeDefined();
  next!.resolve({ hasPasscode: hasCode });
  await settle();
};

let uninstall: () => void;
beforeAll(() => {
  uninstall = installDeviceIdentity();
});
afterAll(() => uninstall());

beforeEach(() => {
  calls.length = 0;
  pendingStatus.length = 0;
  bootstrapStores.mockClear();
  resetBootstrapState.mockClear();
  // The phone, open and unlocked, with a known answer of "no passcode".
  autoLockPolicy.set('onClose');
  hasPasscode.set(false);
  passcodeAnswerFor.set('phone');
  isLocked.set(false);
  openDevice.set('phone');
});

afterEach(async () => {
  openDevice.set(null);
  setActiveDevice('phone');
  // Drain the switch back, so the next test starts from a settled phone.
  while (pendingStatus.length) await answerStatus(false);
  await settle();
});

/** MICA-264: switching device is switching identity, passcode first. */
describe('a switch of the active device', () => {
  it("asks the new device's passcode, stamped with it, and locks until it answers", async () => {
    setActiveDevice('tablet');
    // The browser's swap: the frame stays up. The phone's "no passcode" is not the tablet's,
    // so the tablet does not open unlocked on it.
    expect(get(passcodeAnswerFor)).toBeNull();
    expect(get(isLocked)).toBe(true);
    expect(calls).toContainEqual({ id: 'lockscreen', action: 'status', device: 'tablet' });

    openDevice.set('tablet');
    await answerStatus(true);
    expect(get(hasPasscode)).toBe(true);
    expect(get(passcodeAnswerFor)).toBe('tablet');
    expect(get(isLocked)).toBe(true);
  });

  it('unlocks once the new device answers that it has no passcode', async () => {
    hasPasscode.set(true);
    setActiveDevice('tablet');
    openDevice.set('tablet');
    expect(get(isLocked)).toBe(true);

    await answerStatus(false);
    expect(get(hasPasscode)).toBe(false);
    expect(get(isLocked)).toBe(false);
  });

  it('locks a frame raised in the same tick as the switch, then re-evaluates on the answer', async () => {
    // In game: `setVisible { device: 'tablet' }` while closed. `Shell.svelte` sets the device,
    // then `visible`, and its effect evaluates the lock before any answer can be back.
    openDevice.set(null);
    setActiveDevice('tablet');
    expect(get(isLocked)).toBe(false);
    openDevice.set('tablet');
    evaluateLockOnOpen();
    expect(get(isLocked)).toBe(true);

    await answerStatus(false);
    expect(get(isLocked)).toBe(false);
  });

  it('drops an answer that lands after the player has moved on to another device', async () => {
    setActiveDevice('tablet');
    setActiveDevice('phone');
    openDevice.set('phone');
    expect(pendingStatus.map((p) => p.device)).toEqual(['tablet', 'phone']);

    // The tablet's "yes" arrives first, and is not the phone's.
    await answerStatus(true);
    expect(get(hasPasscode)).toBe(false);
    expect(get(passcodeAnswerFor)).toBeNull();

    await answerStatus(false);
    expect(get(passcodeAnswerFor)).toBe('phone');
    expect(get(isLocked)).toBe(false);
  });

  it("re-runs the bootstrap and re-reads the new device's settings", async () => {
    setActiveDevice('tablet');
    expect(resetBootstrapState).toHaveBeenCalledOnce();
    expect(bootstrapStores).toHaveBeenCalledWith(true);
    expect(calls).toContainEqual({ id: 'settings', action: 'getAll', device: undefined });
  });

  it('leaves the bootstrap to the next open when no frame is up', async () => {
    openDevice.set(null);
    setActiveDevice('tablet');
    expect(resetBootstrapState).toHaveBeenCalledOnce();
    expect(bootstrapStores).not.toHaveBeenCalled();
  });

  it('does nothing when the device set is the one already active', () => {
    setActiveDevice('phone');
    expect(calls).toEqual([]);
    expect(get(passcodeAnswerFor)).toBe('phone');
  });
});
