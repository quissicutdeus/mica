// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The idle animation and held prop's asset loads (MICA-369): a dictionary or model that
 * never streams in gives up after a timeout, one that does not exist is never requested,
 * and a load whose device closed mid-way stops polling instead of finishing for nobody.
 *
 * Manual native stubs on `globalThis`, with fake timers driving the 10ms poll and
 * `GetGameTimer` reading the faked clock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEVICES } from '@mica/shared/devices';

type Animation = typeof import('../game/DeviceAnimation').DeviceAnimation;

const PED = 7;
const g = globalThis as Record<string, unknown>;

let dictExists: boolean;
let dictLoaded: boolean;
let modelValid: boolean;
let modelLoaded: boolean;
let calls: Record<string, unknown[][]>;

const record =
  (name: string, answer?: (...args: unknown[]) => unknown) =>
  (...args: unknown[]) => {
    (calls[name] ??= []).push(args);
    return answer?.(...args);
  };

const count = (name: string): number => calls[name]?.length ?? 0;

const load = async (): Promise<Animation> => {
  vi.resetModules();
  return (await import('../game/DeviceAnimation')).DeviceAnimation;
};

beforeEach(() => {
  vi.useFakeTimers();
  dictExists = true;
  dictLoaded = false;
  modelValid = true;
  modelLoaded = false;
  calls = {};
  vi.spyOn(console, 'warn').mockImplementation(() => {});

  Object.assign(g, {
    GetGameTimer: () => Date.now(),
    DoesAnimDictExist: record('DoesAnimDictExist', () => dictExists),
    RequestAnimDict: record('RequestAnimDict'),
    HasAnimDictLoaded: record('HasAnimDictLoaded', () => dictLoaded),
    RemoveAnimDict: record('RemoveAnimDict'),
    TaskPlayAnim: record('TaskPlayAnim'),
    StopAnimTask: record('StopAnimTask'),
    GetFollowPedCamViewMode: () => 1,
    SetFollowPedCamViewMode: record('SetFollowPedCamViewMode'),
    GetHashKey: (name: string) => name.length,
    IsModelValid: record('IsModelValid', () => modelValid),
    RequestModel: record('RequestModel'),
    HasModelLoaded: record('HasModelLoaded', () => modelLoaded),
    SetModelAsNoLongerNeeded: record('SetModelAsNoLongerNeeded'),
    GetEntityCoords: () => [0, 0, 0],
    CreateObject: record('CreateObject', () => 99),
    GetPedBoneIndex: () => 1,
    AttachEntityToEntity: record('AttachEntityToEntity'),
    DeleteObject: record('DeleteObject')
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('animation dictionary', () => {
  it('plays once the dictionary arrives', async () => {
    const animation = await load();
    const done = animation.playIdle(PED, DEVICES.phone);

    await vi.advanceTimersByTimeAsync(100);
    dictLoaded = true;
    await vi.advanceTimersByTimeAsync(20);
    await done;

    expect(count('TaskPlayAnim')).toBe(1);
  });

  it('gives up after the timeout on a dictionary that never loads, and stops polling', async () => {
    const animation = await load();
    let settled = false;
    void animation.playIdle(PED, DEVICES.phone).then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(2000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);

    expect(settled).toBe(true);
    expect(count('TaskPlayAnim')).toBe(0);
    expect(count('RemoveAnimDict')).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('requests a dictionary reported missing anyway, warning once', async () => {
    // DoesAnimDictExist is unverified in game; a wrong "no" must not stop the phone animating.
    dictExists = false;
    dictLoaded = true;
    const animation = await load();

    await animation.playIdle(PED, DEVICES.phone);
    await animation.playIdle(PED, DEVICES.phone);

    expect(count('RequestAnimDict')).toBe(2);
    expect(count('TaskPlayAnim')).toBe(2);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('bounds a dictionary that truly is missing by the same timeout', async () => {
    dictExists = false;
    const animation = await load();
    let settled = false;
    void animation.playIdle(PED, DEVICES.phone).then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(3000);

    expect(settled).toBe(true);
    expect(count('TaskPlayAnim')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops polling as soon as the device closes mid-load', async () => {
    const animation = await load();
    let settled = false;
    void animation.playIdle(PED, DEVICES.phone).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(50);

    animation.stopAll(PED);
    await vi.advanceTimersByTimeAsync(20);

    expect(settled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    // A late arrival plays nothing for a device that is down.
    dictLoaded = true;
    await vi.advanceTimersByTimeAsync(100);
    expect(count('TaskPlayAnim')).toBe(0);
  });

  it('leaves one loop, not one per open, when the device is reopened mid-load', async () => {
    const animation = await load();
    for (let i = 0; i < 5; i += 1) {
      void animation.playIdle(PED, DEVICES.phone);
      await vi.advanceTimersByTimeAsync(30);
      animation.stopAll(PED);
    }
    void animation.playIdle(PED, DEVICES.phone);
    await vi.advanceTimersByTimeAsync(30);

    expect(vi.getTimerCount()).toBe(1);
  });
});

describe('prop model', () => {
  it('spawns and attaches the prop once the model arrives', async () => {
    const animation = await load();
    void animation.playIdle(PED, DEVICES.phone);
    animation.spawnProp(PED, DEVICES.phone);

    await vi.advanceTimersByTimeAsync(100);
    modelLoaded = true;
    await vi.advanceTimersByTimeAsync(20);

    expect(count('CreateObject')).toBe(1);
    expect(count('AttachEntityToEntity')).toBe(1);
    expect(animation.getProp()).toBe(99);
  });

  it('gives up after the timeout on a model that never loads, and stops polling', async () => {
    dictLoaded = true;
    const animation = await load();
    await animation.playIdle(PED, DEVICES.phone);
    animation.spawnProp(PED, DEVICES.phone);

    await vi.advanceTimersByTimeAsync(3000);

    expect(count('CreateObject')).toBe(0);
    expect(count('SetModelAsNoLongerNeeded')).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never requests a model that is not valid', async () => {
    modelValid = false;
    const animation = await load();
    animation.spawnProp(PED, DEVICES.phone);
    await vi.advanceTimersByTimeAsync(0);

    expect(count('RequestModel')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops polling, and spawns nothing, once the prop is removed mid-load', async () => {
    dictLoaded = true;
    const animation = await load();
    await animation.playIdle(PED, DEVICES.phone);
    animation.spawnProp(PED, DEVICES.phone);
    await vi.advanceTimersByTimeAsync(50);

    animation.removeProp();
    await vi.advanceTimersByTimeAsync(20);
    expect(vi.getTimerCount()).toBe(0);

    modelLoaded = true;
    await vi.advanceTimersByTimeAsync(100);
    expect(count('CreateObject')).toBe(0);
  });

  it('is not cancelled by the camera app restarting the animation', async () => {
    dictLoaded = true;
    const animation = await load();
    await animation.playIdle(PED, DEVICES.phone);
    animation.spawnProp(PED, DEVICES.phone);
    await vi.advanceTimersByTimeAsync(50);

    await animation.setCameraApp(PED, true, true);
    modelLoaded = true;
    await vi.advanceTimersByTimeAsync(20);

    expect(count('CreateObject')).toBe(1);
  });
});
