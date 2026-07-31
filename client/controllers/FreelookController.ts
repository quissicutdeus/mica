export class FreelookController {
  private static isFreelookActive = false;
  private static freelookTick: number | null = null;

  public static enableFreelook(): void {
    FreelookController.isFreelookActive = true;
    SetNuiFocus(true, false);
    SetNuiFocusKeepInput(true);

    if (FreelookController.freelookTick === null) {
      FreelookController.freelookTick = setTick(() => {
        DisableAllControlActions(0);
        EnableControlAction(0, 1, true); // Look left/right
        EnableControlAction(0, 2, true); // Look up/down
        EnableControlAction(0, 30, true); // Move left/right
        EnableControlAction(0, 31, true); // Move forward/back
        EnableControlAction(0, 36, true); // Crouch
        EnableControlAction(0, 21, true); // Sprint
        EnableControlAction(0, 22, true); // Jump
      });
    }
  }

  public static disableFreelook(): void {
    FreelookController.isFreelookActive = false;
    SetNuiFocusKeepInput(false);
    SetNuiFocus(true, true);

    if (FreelookController.freelookTick !== null) {
      clearTick(FreelookController.freelookTick);
      FreelookController.freelookTick = null;
    }
  }

  public static resetFreelook(): void {
    FreelookController.isFreelookActive = false;
    SetNuiFocusKeepInput(false);
    SetNuiFocus(false, false);

    if (FreelookController.freelookTick !== null) {
      clearTick(FreelookController.freelookTick);
      FreelookController.freelookTick = null;
    }
  }

  public static isActive(): boolean {
    return FreelookController.isFreelookActive;
  }
}
