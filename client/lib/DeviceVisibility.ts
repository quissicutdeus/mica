// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { DEVICES, type DeviceId } from '@mica/shared/devices';
import { sendNuiMessage } from './nui';
import { DeviceState } from './DeviceState';
import { sendChargeToNui } from '../services/Battery';
import { DeviceAnimation } from '../game/DeviceAnimation';
import { Freelook } from '../game/Freelook';
import { PhoneCamera } from '../game/PhoneCamera';

/**
 * The open/close sequence the toggle command used to own outright, factored out so
 * `SetPhoneEnabled`, `OpenApp` (`services/Shell.ts`) and an incoming call can reach it too.
 *
 * Lives in `lib/` rather than `client.ts` itself so both `client.ts` and `services/Shell.ts`
 * can import it — `client.ts` imports `./services` at its top, so the reverse import would
 * be circular.
 *
 * Per device since MICA-262. Raising one device lowers the other first: NUI focus is
 * process-global and there is one page, so two frames can never be up at once, and the
 * web side (`state/device.ts`) assumes exactly that.
 */

const sendTimeToNui = () => {
  sendNuiMessage('setTime', { hours: GetClockHours(), minutes: GetClockMinutes() });
};

export const openDevice = (id: DeviceId): void => {
  const other = DeviceState.openDevice();
  if (other && other !== id) closeDevice(other);

  const descriptor = DEVICES[id];
  DeviceState.setOpen(id, true);
  SetNuiFocus(true, true);
  sendNuiMessage('setVisible', { device: id, visible: true });

  const ped = PlayerPedId();
  void DeviceAnimation.playIdle(ped, descriptor);
  DeviceAnimation.spawnProp(ped, descriptor);

  sendTimeToNui();
  sendChargeToNui();
};

export const closeDevice = (id: DeviceId): void => {
  const descriptor = DEVICES[id];
  DeviceState.setOpen(id, false);

  const ped = PlayerPedId();
  // Only the phone has a camera to put down; the scripted cam is never up for the tablet.
  if (descriptor.chrome.camera) PhoneCamera.disable();
  DeviceAnimation.removeProp();
  DeviceAnimation.stopAll(ped);
  Freelook.resetFreelook();

  sendNuiMessage('setVisible', { device: id, visible: false });
};

/** Lower whatever is up — `hideFrame` and Escape do not say which, and need not. */
export const closeOpenDevice = (): void => {
  const open = DeviceState.openDevice();
  if (open) closeDevice(open);
};
