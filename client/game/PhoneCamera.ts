import { PhoneAnimation } from './PhoneAnimation';
import { sendNuiMessage } from '../lib/nui';

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

export class PhoneCamera {
  private static cam: number | null = null;
  private static tick: number | null = null;
  private static frontFacing = false;
  private static propWasVisible = true;

  public static isActive(): boolean {
    return PhoneCamera.cam !== null;
  }

  public static isFrontFacing(): boolean {
    return PhoneCamera.frontFacing;
  }

  public static enable(frontFacing = false): void {
    if (PhoneCamera.cam !== null) {
      PhoneCamera.setFrontFacing(frontFacing);
      return;
    }

    const ped = PlayerPedId();
    const cam = CreateCam('DEFAULT_SCRIPTED_CAMERA', true);
    PhoneCamera.cam = cam;
    PhoneCamera.frontFacing = frontFacing;

    SetCamFov(cam, PHONE_CAMERA_TUNING.fov);
    PhoneCamera.attach(ped, frontFacing);
    SetCamActive(cam, true);
    RenderScriptCams(true, false, 0, true, true);

    PhoneCamera.hidePhoneProp();

    // The camera has to follow where the player is looking, and an attached cam does not
    // inherit that on its own — the bone's rotation is the head's, which lags and rolls
    // with the animation. Driving it from the gameplay cam each frame keeps aim and
    // freelook working exactly as they do outside the app.
    PhoneCamera.tick = setTick(() => {
      const active = PhoneCamera.cam;
      if (active === null) return;

      const [pitch, roll, yaw] = GetGameplayCamRot(2);
      SetCamRot(active, pitch, roll, PhoneCamera.frontFacing ? yaw + 180.0 : yaw, 2);

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
    if (PhoneCamera.cam === null || PhoneCamera.frontFacing === frontFacing) {
      return;
    }
    PhoneCamera.frontFacing = frontFacing;
    PhoneCamera.attach(PlayerPedId(), frontFacing);
  }

  public static disable(): void {
    if (PhoneCamera.tick !== null) {
      clearTick(PhoneCamera.tick);
      PhoneCamera.tick = null;
    }

    if (PhoneCamera.cam !== null) {
      RenderScriptCams(false, false, 0, true, true);
      DestroyCam(PhoneCamera.cam, false);
      PhoneCamera.cam = null;
    }

    PhoneCamera.frontFacing = false;
    PhoneCamera.restorePhoneProp();
  }

  private static attach(ped: number, frontFacing: boolean): void {
    const cam = PhoneCamera.cam;
    if (cam === null) return;

    const offset = frontFacing ? PHONE_CAMERA_TUNING.front : PHONE_CAMERA_TUNING.rear;
    AttachCamToPedBone(cam, ped, BONE_HEAD, offset.x, offset.y, offset.z, true);
  }

  private static hidePhoneProp(): void {
    const prop = PhoneAnimation.getPhoneProp();
    if (prop === null || !DoesEntityExist(prop)) return;
    PhoneCamera.propWasVisible = IsEntityVisible(prop);
    SetEntityVisible(prop, false, false);
  }

  private static restorePhoneProp(): void {
    const prop = PhoneAnimation.getPhoneProp();
    if (prop === null || !DoesEntityExist(prop)) return;
    SetEntityVisible(prop, PhoneCamera.propWasVisible, false);
  }
}
