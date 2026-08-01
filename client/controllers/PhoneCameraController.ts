import { PhoneAnimationController } from './PhoneAnimationController';
import { sendNuiMessage } from '../lib/NuiUtils';

/**
 * A scripted camera for the Camera app, so the shot is taken from the phone rather than
 * from the player's eyes.
 *
 * The Camera app used to just force `SetFollowPedCamViewMode(4)` — first person. That
 * renders from the *head*, and the phone is held out in front of it, so the prop and
 * the whole forearm sat in the bottom-left of every viewfinder and every photo. No view
 * mode fixes that; the origin has to move.
 *
 * Two things get the phone out of shot, deliberately both:
 *
 *   1. The camera is pushed forward past the hand.
 *   2. The prop is hidden locally while the app is open.
 *
 * (2) alone would leave the arm visible; (1) alone depends on an offset that has to
 * clear a hand position which varies with the animation. `SetEntityVisible` is
 * client-side only, so other players still see the character holding a phone.
 */

/** SKEL_Head — the offsets below are relative to this bone. */
const BONE_HEAD = 31086;

/** INPUT_ATTACK — left mouse button. */
const INPUT_ATTACK = 24;

/**
 * Tunable in one place, because the right numbers are a matter of looking at it in game
 * against a specific prop and animation, not of arithmetic.
 */
export const PHONE_CAMERA_TUNING = {
  /** Narrower than the gameplay cam; a phone lens is not a 70-degree fisheye. */
  fov: 55.0,

  /**
   * Rear camera, relative to the head bone. `y` is forward.
   *
   * Far enough forward to clear the outstretched hand, close enough not to poke through
   * a wall the player is standing against.
   */
  rear: { x: 0.0, y: 0.45, z: 0.0 },

  /** Front camera: in front of and slightly above the face, looking back at it. */
  front: { x: 0.0, y: 0.6, z: 0.05 },

  /** Seconds of interpolation when flipping. 0 cuts instantly. */
  flipEaseMs: 350
};

export class PhoneCameraController {
  private static cam: number | null = null;
  private static tick: number | null = null;
  private static frontFacing = false;
  private static propWasVisible = true;

  public static isActive(): boolean {
    return PhoneCameraController.cam !== null;
  }

  public static isFrontFacing(): boolean {
    return PhoneCameraController.frontFacing;
  }

  public static enable(frontFacing = false): void {
    if (PhoneCameraController.cam !== null) {
      PhoneCameraController.setFrontFacing(frontFacing);
      return;
    }

    const ped = PlayerPedId();
    const cam = CreateCam('DEFAULT_SCRIPTED_CAMERA', true);
    PhoneCameraController.cam = cam;
    PhoneCameraController.frontFacing = frontFacing;

    SetCamFov(cam, PHONE_CAMERA_TUNING.fov);
    PhoneCameraController.attach(ped, frontFacing);
    SetCamActive(cam, true);
    RenderScriptCams(true, false, 0, true, true);

    PhoneCameraController.hidePhoneProp();

    // The camera has to follow where the player is looking, and an attached cam does not
    // inherit that on its own — the bone's rotation is the head's, which lags and rolls
    // with the animation. Driving it from the gameplay cam each frame keeps aim and
    // freelook working exactly as they do outside the app.
    PhoneCameraController.tick = setTick(() => {
      const active = PhoneCameraController.cam;
      if (active === null) return;

      const [pitch, roll, yaw] = GetGameplayCamRot(2);
      SetCamRot(active, pitch, roll, PhoneCameraController.frontFacing ? yaw + 180.0 : yaw, 2);

      // Left click takes the photo. It has to be read from the *game* rather than the
      // page: aiming means no NUI cursor, so the web never receives a click at all.
      // `IsDisabledControlJustPressed` because the aim profile disables attack, and a
      // disabled control still reports its state.
      if (IsDisabledControlJustPressed(0, INPUT_ATTACK)) {
        sendNuiMessage('cameraShutter', {});
      }
    });
  }

  public static setFrontFacing(frontFacing: boolean): void {
    if (PhoneCameraController.cam === null || PhoneCameraController.frontFacing === frontFacing) {
      return;
    }
    PhoneCameraController.frontFacing = frontFacing;
    PhoneCameraController.attach(PlayerPedId(), frontFacing);
  }

  public static disable(): void {
    if (PhoneCameraController.tick !== null) {
      clearTick(PhoneCameraController.tick);
      PhoneCameraController.tick = null;
    }

    if (PhoneCameraController.cam !== null) {
      RenderScriptCams(false, false, 0, true, true);
      DestroyCam(PhoneCameraController.cam, false);
      PhoneCameraController.cam = null;
    }

    PhoneCameraController.frontFacing = false;
    PhoneCameraController.restorePhoneProp();
  }

  private static attach(ped: number, frontFacing: boolean): void {
    const cam = PhoneCameraController.cam;
    if (cam === null) return;

    const offset = frontFacing ? PHONE_CAMERA_TUNING.front : PHONE_CAMERA_TUNING.rear;
    AttachCamToPedBone(cam, ped, BONE_HEAD, offset.x, offset.y, offset.z, true);
  }

  private static hidePhoneProp(): void {
    const prop = PhoneAnimationController.getPhoneProp();
    if (prop === null || !DoesEntityExist(prop)) return;
    PhoneCameraController.propWasVisible = IsEntityVisible(prop);
    SetEntityVisible(prop, false, false);
  }

  private static restorePhoneProp(): void {
    const prop = PhoneAnimationController.getPhoneProp();
    if (prop === null || !DoesEntityExist(prop)) return;
    SetEntityVisible(prop, PhoneCameraController.propWasVisible, false);
  }
}
