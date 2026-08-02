interface AppState {
  dict: string;
  anim: string;
  init?: () => void;
  cleanup?: () => void;
}

const delay = (ms: number) => new Promise((res) => setTimeout(() => res(true), ms));

export class PhoneAnimation {
  private static phoneProp: number | null = null;
  private static activeApp: string | null = null;
  private static savedCameraViewMode: number | null = null;
  private static currentAnimId = 0;

  private static appStates: Record<string, AppState> = {
    camera: {
      dict: 'amb@world_human_tourist_mobile@male@base',
      anim: 'base',
      init: () => {
        PhoneAnimation.savedCameraViewMode = GetFollowPedCamViewMode();
        SetFollowPedCamViewMode(4);
      },
      cleanup: () => {
        if (PhoneAnimation.savedCameraViewMode !== null) {
          SetFollowPedCamViewMode(PhoneAnimation.savedCameraViewMode);
          PhoneAnimation.savedCameraViewMode = null;
        }
      }
    },
    default: {
      dict: 'cellphone@',
      anim: 'cellphone_text_read_base'
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

  public static async playAppAnimation(
    ped: number,
    appName: string | null,
    isPhoneOpen: boolean
  ): Promise<void> {
    const animId = ++PhoneAnimation.currentAnimId;
    const state =
      appName && PhoneAnimation.appStates[appName]
        ? PhoneAnimation.appStates[appName]
        : PhoneAnimation.appStates.default;

    await PhoneAnimation.loadAnimDict(state.dict);

    // Abort if another animation was requested or phone was closed while loading
    if (animId !== PhoneAnimation.currentAnimId || !isPhoneOpen) {
      RemoveAnimDict(state.dict);
      return;
    }

    if (appName && PhoneAnimation.appStates[appName] && PhoneAnimation.appStates[appName].init) {
      PhoneAnimation.appStates[appName].init!();
    }

    TaskPlayAnim(ped, state.dict, state.anim, 8.0, 8.0, -1, 50, 0, false, false, false);
    RemoveAnimDict(state.dict);
  }

  public static stopAllPhoneAnimations(ped: number): void {
    PhoneAnimation.currentAnimId++; // Cancel any pending animations
    if (PhoneAnimation.activeApp && PhoneAnimation.appStates[PhoneAnimation.activeApp]) {
      if (PhoneAnimation.appStates[PhoneAnimation.activeApp].cleanup) {
        PhoneAnimation.appStates[PhoneAnimation.activeApp].cleanup!();
      }
      StopAnimTask(
        ped,
        PhoneAnimation.appStates[PhoneAnimation.activeApp].dict,
        PhoneAnimation.appStates[PhoneAnimation.activeApp].anim,
        1.0
      );
    }
    PhoneAnimation.activeApp = null;
    StopAnimTask(
      ped,
      PhoneAnimation.appStates.default.dict,
      PhoneAnimation.appStates.default.anim,
      1.0
    );
  }

  public static spawnPhoneProp(ped: number, isPhoneOpen: boolean): void {
    PhoneAnimation.loadModel('prop_npc_phone_02').then(() => {
      if (!isPhoneOpen || PhoneAnimation.phoneProp) return;
      const coords = GetEntityCoords(ped, true);
      PhoneAnimation.phoneProp = CreateObject(
        GetHashKey('prop_npc_phone_02'),
        coords[0],
        coords[1],
        coords[2],
        true,
        true,
        false
      );
      AttachEntityToEntity(
        PhoneAnimation.phoneProp,
        ped,
        GetPedBoneIndex(ped, 28422),
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        true,
        true,
        false,
        true,
        1,
        true
      );
      SetModelAsNoLongerNeeded(GetHashKey('prop_npc_phone_02'));
    });
  }

  /** The held prop, so the scripted camera can hide it while framing a shot. */
  public static getPhoneProp(): number | null {
    return PhoneAnimation.phoneProp;
  }

  public static removePhoneProp(): void {
    if (PhoneAnimation.phoneProp) {
      DeleteObject(PhoneAnimation.phoneProp);
      PhoneAnimation.phoneProp = null;
    }
  }

  public static async setCameraApp(
    ped: number,
    active: boolean,
    isPhoneOpen: boolean
  ): Promise<void> {
    if (active) {
      PhoneAnimation.activeApp = 'camera';
      await PhoneAnimation.playAppAnimation(ped, PhoneAnimation.activeApp, isPhoneOpen);
    } else {
      if (PhoneAnimation.activeApp === 'camera') {
        if (PhoneAnimation.appStates.camera.cleanup) {
          PhoneAnimation.appStates.camera.cleanup();
        }
        StopAnimTask(
          ped,
          PhoneAnimation.appStates.camera.dict,
          PhoneAnimation.appStates.camera.anim,
          1.0
        );
        PhoneAnimation.activeApp = null;
      }
      await PhoneAnimation.playAppAnimation(ped, null, isPhoneOpen);
    }
  }
}
