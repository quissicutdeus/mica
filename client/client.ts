// SPDX-FileCopyrightText: 2025 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import './services';
import './game';
import { FrameworkBridge } from './lib/FrameworkBridge';
import { sendNuiMessage } from './lib/nui';
import { DeviceState } from './lib/DeviceState';
import { openDevice, closeDevice, closeOpenDevice } from './lib/DeviceVisibility';
import { DeviceAnimation } from './game/DeviceAnimation';
import { Freelook } from './game/Freelook';
import { PhoneCamera } from './game/PhoneCamera';
import { GAME_SCOPE_ACTIONS } from '@mica/shared/keybinds';
import { ALL_DEVICES, DEVICES, type DeviceId } from '@mica/shared/devices';
import { requestDeviceItemCheck } from './services/DeviceItem';

// Send system time to NUI
const sendTimeToNui = () => {
  const hours = GetClockHours();
  const minutes = GetClockMinutes();
  sendNuiMessage('setTime', { hours, minutes });
};

/**
 * The toggle behind each device's key (MICA-262). Pressing the key of the device that
 * is up puts it down; pressing the other device's key raises it, which lowers the first
 * on the way — one frame at a time is the rule (`lib/DeviceVisibility.ts`).
 */
const toggleDevice = (id: DeviceId): void => {
  // Belt and braces alongside the dispatcher's own guard: whatever key ends up bound
  // to this, it must never fire out from under a focused text field.
  if (DeviceState.isTyping()) return;

  if (DeviceState.isOpen(id)) {
    closeDevice(id);
    return;
  }
  // A disabled device refuses to open at all; closing it is always allowed.
  if (!DeviceState.isEnabled(id)) {
    // MICA-229: a refusal for want of the item is the moment to make sure the server's
    // last word is current -- an inventory event can be missed, and this costs one request.
    requestDeviceItemCheck();
    return;
  }
  openDevice(id);
};

// One command per device, named by the descriptor: `togglePhone` predates the table and
// players already have it bound; `toggleTablet` is the tablet's.
for (const id of ALL_DEVICES) {
  RegisterCommand(DEVICES[id].keybind.command, () => toggleDevice(id), false);
}

/**
 * Register every game-scope action from the shared table.
 *
 * Only actions usable with the phone *closed* live here — while it is open,
 * `SetNuiFocus(true, true)` means the game receives no control input, so a mapping
 * cannot fire. In-phone keys are dispatched by the web and rebound in Settings >
 * Shortcuts instead. Registering these through `RegisterKeyMapping` is what puts them
 * in FiveM's own Key Bindings menu.
 *
 * Only the actions whose command the loop above registered: a mapping for a command
 * nobody has registered would put a key in FiveM's menu that does nothing.
 */
const REGISTERED_COMMANDS = new Set(ALL_DEVICES.map((id) => DEVICES[id].keybind.command));

for (const action of GAME_SCOPE_ACTIONS) {
  const command = action.command ?? action.id;
  if (!REGISTERED_COMMANDS.has(command)) continue;
  RegisterKeyMapping(command, action.label, 'keyboard', action.defaultKey);
}

// NUI Callback to toggle freelook
RegisterNuiCallbackType('toggleFreelook');
on('__cfx_nui:toggleFreelook', (data: { state: boolean }, cb: Function) => {
  if (DeviceState.isAnyOpen()) {
    if (data && data.state) {
      // The camera app holds this open indefinitely, so it gets the narrower profile.
      Freelook.enableFreelook(PhoneCamera.isActive() ? 'camera' : 'freelook');
    } else {
      Freelook.disableFreelook();
    }
  }
  cb({});
});

// Whether a text field in the NUI has focus. See PhoneState.isTyping.
RegisterNuiCallbackType('setTyping');
on('__cfx_nui:setTyping', (data: { typing: boolean }, cb: Function) => {
  DeviceState.setTyping(Boolean(data?.typing));
  cb({});
});

// NUI Callback to close whichever device is up.
RegisterNuiCallbackType('hideFrame');
on('__cfx_nui:hideFrame', (_: any, cb: Function) => {
  DeviceState.setTyping(false);
  closeOpenDevice();
  cb({});
});

// NUI Callback for camera app animation state
RegisterNuiCallbackType('onCameraApp');
on('__cfx_nui:onCameraApp', async (data: { state: boolean }, cb: Function) => {
  const ped = PlayerPedId();
  const active = Boolean(data?.state);
  // Phone only: the camera app cannot be on the tablet (`chrome.camera`).
  await DeviceAnimation.setCameraApp(ped, active, DeviceState.isOpen('phone'));

  // After the animation, so the prop exists and the hand is in position before the cam
  // attaches and hides it.
  if (active && DeviceState.isOpen('phone')) {
    PhoneCamera.enable();
  } else {
    PhoneCamera.disable();
  }
  cb({});
});

// NUI Callback to get bank balance
RegisterNuiCallbackType('getBankBalance');
on('__cfx_nui:getBankBalance', (_: any, cb: Function) => {
  const balance = FrameworkBridge.getBankBalance();
  cb(balance);
});

// NUI Callback to get citizen ID
RegisterNuiCallbackType('getCitizenId');
on('__cfx_nui:getCitizenId', (_: any, cb: Function) => {
  const citizenId = FrameworkBridge.getCitizenId();
  cb(citizenId);
});

// NUI Callback to get phone number
RegisterNuiCallbackType('getPhoneNumber');
on('__cfx_nui:getPhoneNumber', (_: any, cb: Function) => {
  const phone = FrameworkBridge.getPhoneNumber();
  cb(phone || '867-5309');
});

// Time Sync Loop
setInterval(() => {
  if (DeviceState.isAnyOpen()) {
    sendTimeToNui();
  }
}, 1000);
