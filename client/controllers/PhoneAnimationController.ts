interface AppState {
  dict: string;
  anim: string;
  init?: () => void;
  cleanup?: () => void;
}

const delay = (ms: number) => new Promise((res) => setTimeout(() => res(true), ms));

export class PhoneAnimationController {
  private static phoneProp: number | null = null;
  private static activeApp: string | null = null;
  private static savedCameraViewMode: number | null = null;
  private static currentAnimId = 0;

  private static appStates: Record<string, AppState> = {
    camera: {
      dict: 'amb@world_human_tourist_mobile@male@base',
      anim: 'base',
      init: () => {
        PhoneAnimationController.savedCameraViewMode = GetFollowPedCamViewMode();
        SetFollowPedCamViewMode(4);
      },
      cleanup: () => {
        if (PhoneAnimationController.savedCameraViewMode !== null) {
          SetFollowPedCamViewMode(PhoneAnimationController.savedCameraViewMode);
          PhoneAnimationController.savedCameraViewMode = null;
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
    const animId = ++PhoneAnimationController.currentAnimId;
    const state =
      appName && PhoneAnimationController.appStates[appName]
        ? PhoneAnimationController.appStates[appName]
        : PhoneAnimationController.appStates.default;

    await PhoneAnimationController.loadAnimDict(state.dict);

    // Abort if another animation was requested or phone was closed while loading
    if (animId !== PhoneAnimationController.currentAnimId || !isPhoneOpen) {
      RemoveAnimDict(state.dict);
      return;
    }

    if (
      appName &&
      PhoneAnimationController.appStates[appName] &&
      PhoneAnimationController.appStates[appName].init
    ) {
      PhoneAnimationController.appStates[appName].init!();
    }

    TaskPlayAnim(ped, state.dict, state.anim, 8.0, 8.0, -1, 50, 0, false, false, false);
    RemoveAnimDict(state.dict);
  }

  public static stopAllPhoneAnimations(ped: number): void {
    PhoneAnimationController.currentAnimId++; // Cancel any pending animations
    if (
      PhoneAnimationController.activeApp &&
      PhoneAnimationController.appStates[PhoneAnimationController.activeApp]
    ) {
      if (PhoneAnimationController.appStates[PhoneAnimationController.activeApp].cleanup) {
        PhoneAnimationController.appStates[PhoneAnimationController.activeApp].cleanup!();
      }
      StopAnimTask(
        ped,
        PhoneAnimationController.appStates[PhoneAnimationController.activeApp].dict,
        PhoneAnimationController.appStates[PhoneAnimationController.activeApp].anim,
        1.0
      );
    }
    PhoneAnimationController.activeApp = null;
    StopAnimTask(
      ped,
      PhoneAnimationController.appStates.default.dict,
      PhoneAnimationController.appStates.default.anim,
      1.0
    );
  }

  public static spawnPhoneProp(ped: number, isPhoneOpen: boolean): void {
    PhoneAnimationController.loadModel('prop_npc_phone_02').then(() => {
      if (!isPhoneOpen || PhoneAnimationController.phoneProp) return;
      const coords = GetEntityCoords(ped, true);
      PhoneAnimationController.phoneProp = CreateObject(
        GetHashKey('prop_npc_phone_02'),
        coords[0],
        coords[1],
        coords[2],
        true,
        true,
        false
      );
      AttachEntityToEntity(
        PhoneAnimationController.phoneProp,
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

  public static removePhoneProp(): void {
    if (PhoneAnimationController.phoneProp) {
      DeleteObject(PhoneAnimationController.phoneProp);
      PhoneAnimationController.phoneProp = null;
    }
  }

  public static async setCameraApp(
    ped: number,
    active: boolean,
    isPhoneOpen: boolean
  ): Promise<void> {
    if (active) {
      PhoneAnimationController.activeApp = 'camera';
      await PhoneAnimationController.playAppAnimation(
        ped,
        PhoneAnimationController.activeApp,
        isPhoneOpen
      );
    } else {
      if (PhoneAnimationController.activeApp === 'camera') {
        if (PhoneAnimationController.appStates.camera.cleanup) {
          PhoneAnimationController.appStates.camera.cleanup();
        }
        StopAnimTask(
          ped,
          PhoneAnimationController.appStates.camera.dict,
          PhoneAnimationController.appStates.camera.anim,
          1.0
        );
        PhoneAnimationController.activeApp = null;
      }
      await PhoneAnimationController.playAppAnimation(ped, null, isPhoneOpen);
    }
  }
}
