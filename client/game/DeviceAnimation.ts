// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { DEVICES, type DeviceDescriptor } from '@mica/shared/devices';

/**
 * The held prop and the idle animation, for whichever device is up (MICA-262).
 *
 * This was `PhoneAnimation`, with `prop_npc_phone_02` and `cellphone@` written in. Both
 * now come from the descriptor (`shared/devices.ts`), so the tablet is a second row of
 * the table rather than a second copy of this file. What stays phone-only is the camera
 * app's own animation and view mode: the tablet has no camera (`chrome.camera`), and
 * `PhoneCamera` and `Freelook` are untouched.
 */
interface AppState {
  dict: string;
  anim: string;
  init?: () => void;
  cleanup?: () => void;
}

const delay = (ms: number) => new Promise((res) => setTimeout(() => res(true), ms));

export class DeviceAnimation {
  private static prop: number | null = null;
  private static activeApp: string | null = null;
  private static savedCameraViewMode: number | null = null;
  private static currentAnimId = 0;
  /** What is in the hand right now, so `stopAll` knows which idle to stop. */
  private static idle: AppState = DEVICES.phone.animation;

  private static appStates: Record<string, AppState> = {
    camera: {
      dict: 'amb@world_human_tourist_mobile@male@base',
      anim: 'base',
      init: () => {
        DeviceAnimation.savedCameraViewMode = GetFollowPedCamViewMode();
        SetFollowPedCamViewMode(4);
      },
      cleanup: () => {
        if (DeviceAnimation.savedCameraViewMode !== null) {
          SetFollowPedCamViewMode(DeviceAnimation.savedCameraViewMode);
          DeviceAnimation.savedCameraViewMode = null;
        }
      }
    }
  };

  private static async loadAnimDict(dict: string): Promise<void> {
    RequestAnimDict(dict);
    while (!HasAnimDictLoaded(dict)) {
      await delay(10);
    }
  }

  private static async loadModel(model: string | number): Promise<void> {
    const hash = typeof model === 'string' ? GetHashKey(model) : model;
    if (IsModelValid(hash)) {
      RequestModel(hash);
      while (!HasModelLoaded(hash)) {
        await delay(10);
      }
    }
  }

  private static async play(ped: number, state: AppState, init?: () => void): Promise<void> {
    const animId = ++DeviceAnimation.currentAnimId;
    await DeviceAnimation.loadAnimDict(state.dict);

    // Abort if another animation was requested, or the device closed, while loading.
    if (animId !== DeviceAnimation.currentAnimId) {
      RemoveAnimDict(state.dict);
      return;
    }

    init?.();
    TaskPlayAnim(ped, state.dict, state.anim, 8.0, 8.0, -1, 50, 0, false, false, false);
    RemoveAnimDict(state.dict);
  }

  /** The device's own idle: the phone held to read, the tablet held flat. */
  public static playIdle(ped: number, descriptor: DeviceDescriptor): Promise<void> {
    DeviceAnimation.idle = descriptor.animation;
    return DeviceAnimation.play(ped, descriptor.animation);
  }

  public static stopAll(ped: number): void {
    DeviceAnimation.currentAnimId++; // Cancel any pending animations
    if (DeviceAnimation.activeApp && DeviceAnimation.appStates[DeviceAnimation.activeApp]) {
      const state = DeviceAnimation.appStates[DeviceAnimation.activeApp];
      state.cleanup?.();
      StopAnimTask(ped, state.dict, state.anim, 1.0);
    }
    DeviceAnimation.activeApp = null;
    StopAnimTask(ped, DeviceAnimation.idle.dict, DeviceAnimation.idle.anim, 1.0);
  }

  public static spawnProp(ped: number, descriptor: DeviceDescriptor): void {
    const { model, bone, offset, rotation } = descriptor.prop;
    DeviceAnimation.loadModel(model).then(() => {
      // Only if the device is still the one being raised, and nothing is in the hand yet.
      if (DeviceAnimation.idle !== descriptor.animation || DeviceAnimation.prop) return;
      const coords = GetEntityCoords(ped, true);
      DeviceAnimation.prop = CreateObject(
        GetHashKey(model),
        coords[0],
        coords[1],
        coords[2],
        true,
        true,
        false
      );
      AttachEntityToEntity(
        DeviceAnimation.prop,
        ped,
        GetPedBoneIndex(ped, bone),
        offset[0],
        offset[1],
        offset[2],
        rotation[0],
        rotation[1],
        rotation[2],
        true,
        true,
        false,
        true,
        1,
        true
      );
      SetModelAsNoLongerNeeded(GetHashKey(model));
    });
  }

  /** The held prop, so the scripted camera can hide it while framing a shot. */
  public static getProp(): number | null {
    return DeviceAnimation.prop;
  }

  public static removeProp(): void {
    if (DeviceAnimation.prop) {
      DeleteObject(DeviceAnimation.prop);
      DeviceAnimation.prop = null;
    }
  }

  /**
   * The camera app's pose, phone only: the tablet has no camera. `isPhoneOpen` is read
   * after the dictionary loads, so a phone closed mid-load plays nothing.
   */
  public static async setCameraApp(
    ped: number,
    active: boolean,
    isPhoneOpen: boolean
  ): Promise<void> {
    if (!isPhoneOpen) return;
    if (active) {
      DeviceAnimation.activeApp = 'camera';
      const state = DeviceAnimation.appStates.camera;
      await DeviceAnimation.play(ped, state, state.init);
    } else {
      if (DeviceAnimation.activeApp === 'camera') {
        const state = DeviceAnimation.appStates.camera;
        state.cleanup?.();
        StopAnimTask(ped, state.dict, state.anim, 1.0);
        DeviceAnimation.activeApp = null;
      }
      await DeviceAnimation.play(ped, DEVICES.phone.animation);
    }
  }
}
