/**
 * Which controls stay live while the NUI holds input.
 *
 * Two profiles, because the two callers want different things. Plain freelook is held
 * for a moment and should not take anything away. The camera app holds this for as long
 * as it is open, and a control that latches there has no natural moment to clear —
 * running would continue until the phone was closed, which is exactly what happened in
 * game. Framing a photo does not need sprint, jump or crouch, so they are simply not
 * offered.
 */
const CONTROL_PROFILES = {
  freelook: [
    1, // Look left/right
    2, // Look up/down
    30, // Move left/right
    31, // Move forward/back
    36, // Crouch
    21, // Sprint
    22 // Jump
  ],
  camera: [
    1, // Look left/right
    2, // Look up/down
    30, // Move left/right
    31 // Move forward/back
  ]
} as const;

export type ControlProfile = keyof typeof CONTROL_PROFILES;

/**
 * Frames spent forcing every control to read as released after keep-input ends.
 *
 * Enough to survive a frame hitch, short enough that a player genuinely holding a key
 * does not notice the pause.
 */
const FLUSH_FRAMES = 10;

export class FreelookController {
  private static isFreelookActive = false;
  private static freelookTick: number | null = null;
  private static flushTick: number | null = null;
  private static profile: ControlProfile = 'freelook';

  /**
   * Force every control to read as released for a few frames.
   *
   * Turning keep-input off while a key is held strands it. The game stops being sent
   * input mid-press, so it never sees the keyup and goes on believing the control is
   * down — the player keeps walking or running with nothing to stop them short of
   * closing the phone. Disabling everything briefly is what makes the game re-read the
   * controls as up.
   *
   * Always latent in freelook: releasing the key while walking did it. The camera app
   * made it constant by holding keep-input open for the whole session.
   */
  private static flushHeldControls(): void {
    if (FreelookController.flushTick !== null) {
      clearTick(FreelookController.flushTick);
      FreelookController.flushTick = null;
    }

    let frames = 0;
    FreelookController.flushTick = setTick(() => {
      DisableAllControlActions(0);
      frames += 1;
      if (frames >= FLUSH_FRAMES && FreelookController.flushTick !== null) {
        clearTick(FreelookController.flushTick);
        FreelookController.flushTick = null;
      }
    });
  }

  private static cancelFlush(): void {
    if (FreelookController.flushTick !== null) {
      clearTick(FreelookController.flushTick);
      FreelookController.flushTick = null;
    }
  }

  public static enableFreelook(profile: ControlProfile = 'freelook'): void {
    // A flush still running would fight the profile about to be applied.
    FreelookController.cancelFlush();
    FreelookController.isFreelookActive = true;
    FreelookController.profile = profile;
    SetNuiFocus(true, false);
    SetNuiFocusKeepInput(true);

    if (FreelookController.freelookTick === null) {
      FreelookController.freelookTick = setTick(() => {
        DisableAllControlActions(0);
        for (const control of CONTROL_PROFILES[FreelookController.profile]) {
          EnableControlAction(0, control, true);
        }
      });
    }
  }

  public static disableFreelook(): void {
    FreelookController.isFreelookActive = false;
    SetNuiFocusKeepInput(false);
    SetNuiFocus(true, true);
    FreelookController.flushHeldControls();

    if (FreelookController.freelookTick !== null) {
      clearTick(FreelookController.freelookTick);
      FreelookController.freelookTick = null;
    }
  }

  public static resetFreelook(): void {
    FreelookController.isFreelookActive = false;
    SetNuiFocusKeepInput(false);
    SetNuiFocus(false, false);
    FreelookController.flushHeldControls();

    if (FreelookController.freelookTick !== null) {
      clearTick(FreelookController.freelookTick);
      FreelookController.freelookTick = null;
    }
  }

  public static isActive(): boolean {
    return FreelookController.isFreelookActive;
  }
}
