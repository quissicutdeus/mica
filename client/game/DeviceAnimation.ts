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

/**
 * How long a dictionary or model may take to stream before the load gives up (MICA-369).
 *
 * Both used to poll every 10ms with no limit, so an asset that never arrived — a dictionary
 * a fork renamed, a model the server does not stream — spun forever, and every further open
 * of the device added another loop beside it. A real load finishes well inside this.
 */
const LOAD_TIMEOUT_MS = 2500;
const LOAD_POLL_MS = 10;

export class DeviceAnimation {
  private static prop: number | null = null;
  private static activeApp: string | null = null;
  private static savedCameraViewMode: number | null = null;
  private static currentAnimId = 0;
  /**
   * Bumped by every `spawnProp` and `removeProp`, so a model load knows when the prop it was
   * loading for is no longer wanted. Separate from {@link currentAnimId}: opening the camera
   * app restarts the animation while the device stays up, and must not cancel the prop.
   */
  private static currentPropId = 0;
  /** Dictionaries `DoesAnimDictExist` denied, so each is warned about once per session. */
  private static missingDicts = new Set<string>();
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

  /**
   * Stream `dict` in, answering whether it is ready to play.
   *
   * False, with nothing left requested, when it has not arrived within
   * {@link LOAD_TIMEOUT_MS}, or when `animId` stopped being the current animation — a device
   * closed, or another pose asked for, mid-load.
   *
   * `DoesAnimDictExist` is asked, but only to explain a failure in advance: it is never a
   * gate. Nothing here can check its answer in game, and if it said no to a dictionary that
   * does exist, a gate would mean the phone never animates, silently. The deadline already
   * bounds the cost of requesting one that truly is missing.
   */
  private static async loadAnimDict(dict: string, animId: number): Promise<boolean> {
    if (!DoesAnimDictExist(dict) && !DeviceAnimation.missingDicts.has(dict)) {
      DeviceAnimation.missingDicts.add(dict);
      console.warn(
        `[DeviceAnimation] Animation dictionary '${dict}' reports as missing; requesting it ` +
          'anyway. Reported once per dictionary.'
      );
    }
    RequestAnimDict(dict);
    const deadline = GetGameTimer() + LOAD_TIMEOUT_MS;
    while (!HasAnimDictLoaded(dict)) {
      if (animId !== DeviceAnimation.currentAnimId) {
        RemoveAnimDict(dict);
        return false;
      }
      if (GetGameTimer() >= deadline) {
        console.warn(`[DeviceAnimation] Animation dictionary '${dict}' did not load in time.`);
        RemoveAnimDict(dict);
        return false;
      }
      await delay(LOAD_POLL_MS);
    }
    return true;
  }

  /**
   * Stream `hash` in, answering whether it is ready to spawn. The same timeout as
   * {@link loadAnimDict}, with the prop's own id as the cancellation. Unlike the dictionary
   * check, `IsModelValid` stays a gate, as it was before MICA-369.
   */
  private static async loadModel(hash: number, propId: number): Promise<boolean> {
    if (!IsModelValid(hash)) {
      console.warn(`[DeviceAnimation] Prop model ${hash} is not a valid model.`);
      return false;
    }
    RequestModel(hash);
    const deadline = GetGameTimer() + LOAD_TIMEOUT_MS;
    while (!HasModelLoaded(hash)) {
      if (propId !== DeviceAnimation.currentPropId) {
        SetModelAsNoLongerNeeded(hash);
        return false;
      }
      if (GetGameTimer() >= deadline) {
        console.warn(`[DeviceAnimation] Prop model ${hash} did not load in time.`);
        SetModelAsNoLongerNeeded(hash);
        return false;
      }
      await delay(LOAD_POLL_MS);
    }
    return true;
  }

  private static async play(ped: number, state: AppState, init?: () => void): Promise<void> {
    const animId = ++DeviceAnimation.currentAnimId;
    if (!(await DeviceAnimation.loadAnimDict(state.dict, animId))) return;

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
    const hash = GetHashKey(model);
    const propId = ++DeviceAnimation.currentPropId;
    void DeviceAnimation.loadModel(hash, propId).then((loaded) => {
      if (!loaded) return;
      // Only if this prop is still wanted — no `removeProp` since, which a close calls — the
      // device is still the one being raised, and nothing is in the hand yet.
      if (
        propId !== DeviceAnimation.currentPropId ||
        DeviceAnimation.idle !== descriptor.animation ||
        DeviceAnimation.prop
      ) {
        SetModelAsNoLongerNeeded(hash);
        return;
      }
      const coords = GetEntityCoords(ped, true);
      DeviceAnimation.prop = CreateObject(hash, coords[0], coords[1], coords[2], true, true, false);
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
      SetModelAsNoLongerNeeded(hash);
    });
  }

  /** The held prop, so the scripted camera can hide it while framing a shot. */
  public static getProp(): number | null {
    return DeviceAnimation.prop;
  }

  public static removeProp(): void {
    DeviceAnimation.currentPropId++; // Cancel a prop still loading
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
