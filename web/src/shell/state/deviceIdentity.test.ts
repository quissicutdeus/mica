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
const { calls, pendingStatus, settingsGetAll } = vi.hoisted(() => ({
  /** The settings sweep's answer, which one test makes fail. */
  settingsGetAll: vi.fn((): Promise<unknown> => Promise.resolve([])),
  calls: [] as { id: string; action: string; device?: string }[],
  pendingStatus: [] as {
    device?: string;
    resolve: (v: { hasPasscode: boolean }) => void;
    reject: (e: Error) => void;
  }[]
}));
vi.mock('../../nui/call', () => {
  const answer = (contract: { id: string }, action: string, device?: string) => {
    calls.push({ id: contract.id, action, device });
    if (contract.id === 'lockscreen' && action === 'status') {
      return new Promise((resolve, reject) => pendingStatus.push({ device, resolve, reject }));
    }
    if (contract.id === 'settings' && action === 'getAll') return settingsGetAll();
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

import { installDeviceIdentity, reloadCharacterLock } from './deviceIdentity';
import { setActiveDevice } from './device';
import { openDevice } from './phoneOpen';
import { autoLockPolicy, evaluateLockOnOpen, isLocked, trustLockPolicy } from './lockScreen';
import { hasPasscode, passcodeAnswerFor } from '../../services/passcode';
import {
  DEFAULT_WALLPAPER,
  resetWallpaper,
  setWallpaperImage,
  trustWallpaperOwner,
  wallpaperStore
} from './wallpaper';
import { flushPendingWrites } from '../../host/settingsSync';
import { storage } from '../../host/facets/storage';

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
  trustLockPolicy();
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

/** MICA-385: a character load re-asks the passcode, and an answer it cannot get keeps the lock. */
describe('a character load', () => {
  const refuseStatus = async () => {
    const next = pendingStatus.shift();
    expect(next, 'a lockscreen:status request is out').toBeDefined();
    next!.reject(new Error('Player not authenticated'));
    await settle();
  };

  it('keeps a phone opened on a fresh connect locked when the ask still fails', async () => {
    // Fresh connect: the mount-time ask was refused, so nothing is known, and the phone was
    // raised before the character loaded. The open asks again, and that is refused too.
    passcodeAnswerFor.set(null);
    evaluateLockOnOpen();
    expect(get(isLocked)).toBe(true);
    await refuseStatus();

    const done = reloadCharacterLock();
    await refuseStatus();
    await done;

    expect(get(passcodeAnswerFor)).toBeNull();
    expect(get(isLocked)).toBe(true);
  });

  it('opens it once the loaded character turns out to have no passcode', async () => {
    passcodeAnswerFor.set(null);
    evaluateLockOnOpen();
    await refuseStatus();

    const done = reloadCharacterLock();
    await answerStatus(false);
    await done;

    expect(get(isLocked)).toBe(false);
  });

  it("locks on a switch to a character with a passcode, on the new character's answer", async () => {
    // The previous character: no passcode, phone open and unlocked.
    expect(get(isLocked)).toBe(false);

    const done = reloadCharacterLock();
    // Forgotten at once — the previous character's "no passcode" is not this one's.
    expect(get(passcodeAnswerFor)).toBeNull();
    expect(get(isLocked)).toBe(true);
    expect(calls).toContainEqual({ id: 'lockscreen', action: 'status', device: 'phone' });

    await answerStatus(true);
    await done;

    expect(get(hasPasscode)).toBe(true);
    expect(get(passcodeAnswerFor)).toBe('phone');
    expect(get(isLocked)).toBe(true);
  });

  it('asks again when an open finds the answer unknown, and unlocks on "no passcode"', async () => {
    // The character-load ask failed: unknown, and locked.
    const done = reloadCharacterLock();
    await refuseStatus();
    await done;
    // That reload's own re-evaluation asked once more; refused as well.
    await refuseStatus();
    expect(get(passcodeAnswerFor)).toBeNull();
    expect(get(isLocked)).toBe(true);

    // The player closes and opens the phone: the open asks, and this time it answers.
    openDevice.set(null);
    openDevice.set('phone');
    evaluateLockOnOpen();
    expect(pendingStatus).toHaveLength(1);
    await answerStatus(false);

    expect(get(passcodeAnswerFor)).toBe('phone');
    expect(get(isLocked)).toBe(false);
  });

  it("drops a reply to an ask made before the forget, rather than taking it as the new character's", async () => {
    // An ask for the previous character is still out when the new one loads.
    passcodeAnswerFor.set(null);
    evaluateLockOnOpen();
    expect(pendingStatus).toHaveLength(1);

    const done = reloadCharacterLock();
    expect(pendingStatus).toHaveLength(2);

    // The previous character's late "no passcode" lands first, and is not this one's.
    await answerStatus(false);
    expect(get(passcodeAnswerFor)).toBeNull();
    expect(get(isLocked)).toBe(true);

    await answerStatus(true);
    await done;
    expect(get(hasPasscode)).toBe(true);
    expect(get(isLocked)).toBe(true);
  });

  it("reads the strict policy when the new character's settings fail to load", async () => {
    // The previous character skipped the lock entirely.
    autoLockPolicy.set('never');
    settingsGetAll.mockImplementationOnce(() => Promise.reject(new Error('timeout')));

    const done = reloadCharacterLock();
    await answerStatus(true);
    await done;

    // This character has a passcode, and their own policy never arrived: 'onClose', not the
    // previous character's 'never'.
    expect(get(autoLockPolicy)).toBe('never');
    expect(get(isLocked)).toBe(true);
  });

  it("trusts the saved policy again once the new character's settings land", async () => {
    autoLockPolicy.set('never');
    settingsGetAll.mockImplementationOnce(() =>
      Promise.resolve([
        { app: 'settings', setting_key: 'auto_lock_policy', setting_value: '"never"' }
      ])
    );

    const done = reloadCharacterLock();
    await answerStatus(true);
    await done;

    expect(get(isLocked)).toBe(false);
  });

  it("does not let the previous character's late sweep vouch for the policy", async () => {
    autoLockPolicy.set('never');
    // A's settings answer is held back until after B has loaded.
    let finishSweepA: (rows: unknown) => void = () => {};
    settingsGetAll.mockImplementationOnce(() => new Promise((resolve) => (finishSweepA = resolve)));
    const doneA = reloadCharacterLock();

    // B loads, and B's own sweep fails.
    settingsGetAll.mockImplementationOnce(() => Promise.reject(new Error('timeout')));
    const doneB = reloadCharacterLock();

    await answerStatus(false); // A's passcode ask: from before B's forget, so dropped.
    await answerStatus(true); // B has a passcode.
    await doneB;

    // A's sweep lands last, and succeeds — for A.
    finishSweepA([]);
    await doneA;

    // B's policy never arrived: the strict one, not A's 'never'.
    expect(get(hasPasscode)).toBe(true);
    expect(get(isLocked)).toBe(true);
  });
});

/**
 * MICA-433: a failed sweep leaves the previous identity's `wallpaperOwner` behind, so the photo
 * it vouches for is held back from the start of every identity change until that change's own
 * sweep applies — the lock policy's fail-closed rule, above, applied to the photo.
 */
describe('a character load, for the wallpaper photo', () => {
  const photo = "url('data:image/png;base64,QUJD')";

  /** What the server answers for the character who set the photo. */
  const ownersRows = () => {
    // Through the settings namespace rather than a raw storage key, the way `dock.test.ts`
    // reads one: a `mica:`-prefixed literal reads to `eventNames.test.ts` as a net event.
    const owner = storage('settings').getItem<string>('wallpaperOwner');
    expect(owner, 'setting a photo stored its owner').not.toBeNull();
    return [
      { app: 'settings', setting_key: 'wallpaperOwner', setting_value: JSON.stringify(owner) }
    ];
  };

  beforeEach(() => {
    trustWallpaperOwner();
    setWallpaperImage(photo);
    // Out of the debounce, so the sweep below is free to apply or clear the key.
    flushPendingWrites();
  });

  afterEach(() => {
    trustWallpaperOwner();
    resetWallpaper();
    flushPendingWrites();
  });

  it("shows no photo when the new character's settings fail to load", async () => {
    expect(get(wallpaperStore)).toEqual({ type: 'image', image: photo });
    settingsGetAll.mockImplementationOnce(() => Promise.reject(new Error('timeout')));

    const done = reloadCharacterLock();
    await answerStatus(false);
    await done;

    expect(get(wallpaperStore)).toEqual(DEFAULT_WALLPAPER);
  });

  it("holds it back while the sweep is out, and shows it once the owner's settings land", async () => {
    const rows = ownersRows();
    let finishSweep: (answer: unknown) => void = () => {};
    settingsGetAll.mockImplementationOnce(() => new Promise((resolve) => (finishSweep = resolve)));

    const done = reloadCharacterLock();
    expect(get(wallpaperStore)).toEqual(DEFAULT_WALLPAPER);

    await answerStatus(false);
    finishSweep(rows);
    await done;

    expect(get(wallpaperStore)).toEqual({ type: 'image', image: photo });
  });

  it("does not let the previous character's late sweep vouch for the photo", async () => {
    const rowsOfA = ownersRows();
    let finishSweepA: (answer: unknown) => void = () => {};
    settingsGetAll.mockImplementationOnce(() => new Promise((resolve) => (finishSweepA = resolve)));
    const doneA = reloadCharacterLock();

    // B loads, and B's own sweep fails.
    settingsGetAll.mockImplementationOnce(() => Promise.reject(new Error('timeout')));
    const doneB = reloadCharacterLock();

    await answerStatus(false);
    await answerStatus(false);
    await doneB;

    // A's sweep lands last and succeeds — restoring A's owner row, for A.
    finishSweepA(rowsOfA);
    await doneA;

    expect(get(wallpaperStore)).toEqual(DEFAULT_WALLPAPER);
  });
});
