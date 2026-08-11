import { sendNuiMessage } from './nui';
import { PhoneState } from './PhoneState';
import { sendChargeToNui } from '../services/Battery';
import { PhoneAnimation } from '../game/PhoneAnimation';
import { Freelook } from '../game/Freelook';
import { PhoneCamera } from '../game/PhoneCamera';

/**
 * The open/close sequence `togglePhone` used to own outright, factored out so
 * `SetPhoneEnabled` and `OpenApp` (`services/Shell.ts`) can reach it too.
 *
 * Lives in `lib/` rather than `client.ts` itself so both `client.ts` and `services/Shell.ts`
 * can import it — `client.ts` imports `./services` at its top, so the reverse import would
 * be circular.
 */

const sendTimeToNui = () => {
  sendNuiMessage('setTime', { hours: GetClockHours(), minutes: GetClockMinutes() });
};

export const openPhone = (): void => {
  PhoneState.setOpen(true);
  SetNuiFocus(true, true);
  sendNuiMessage('setVisible', true);

  const ped = PlayerPedId();
  PhoneAnimation.playAppAnimation(ped, null, true);
  PhoneAnimation.spawnPhoneProp(ped, true);

  sendTimeToNui();
  sendChargeToNui();
};

export const closePhone = (): void => {
  PhoneState.setOpen(false);

  const ped = PlayerPedId();
  PhoneCamera.disable();
  PhoneAnimation.removePhoneProp();
  PhoneAnimation.stopAllPhoneAnimations(ped);
  Freelook.resetFreelook();

  sendNuiMessage('setVisible', false);
};
