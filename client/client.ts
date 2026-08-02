import './services';
import './game';
import { sendChargeToNui } from './services/Battery';
import { FrameworkBridge } from './lib/FrameworkBridge';
import { sendNuiMessage } from './lib/nui';
import { PhoneState } from './lib/PhoneState';
import { PhoneAnimation } from './game/PhoneAnimation';
import { Freelook } from './game/Freelook';
import { PhoneCamera } from './game/PhoneCamera';
import { GAME_SCOPE_ACTIONS } from '@shared/keybinds';

// Send system time to NUI
const sendTimeToNui = () => {
  const hours = GetClockHours();
  const minutes = GetClockMinutes();
  sendNuiMessage('setTime', { hours, minutes });
};

// Toggle Phone Command
RegisterCommand(
  'togglePhone',
  () => {
    // Belt and braces alongside the dispatcher's own guard: whatever key ends up bound
    // to this, it must never fire out from under a focused text field.
    if (PhoneState.isTyping()) return;

    const open = !PhoneState.isOpen();
    PhoneState.setOpen(open);

    if (open) {
      SetNuiFocus(true, true);
      sendNuiMessage('setVisible', true);

      const ped = PlayerPedId();
      PhoneAnimation.playAppAnimation(ped, null, open);
      PhoneAnimation.spawnPhoneProp(ped, open);

      // Send time and battery charge immediately when opening
      sendTimeToNui();
      sendChargeToNui();
    } else {
      const ped = PlayerPedId();
      PhoneCamera.disable();
      PhoneAnimation.removePhoneProp();
      PhoneAnimation.stopAllPhoneAnimations(ped);
      Freelook.resetFreelook();

      sendNuiMessage('setVisible', false);
    }
  },
  false
);

/**
 * Register every game-scope action from the shared table.
 *
 * Only actions usable with the phone *closed* live here — while it is open,
 * `SetNuiFocus(true, true)` means the game receives no control input, so a mapping
 * cannot fire. In-phone keys are dispatched by the web and rebound in Settings >
 * Shortcuts instead. Registering these through `RegisterKeyMapping` is what puts them
 * in FiveM's own Key Bindings menu.
 */
for (const action of GAME_SCOPE_ACTIONS) {
  RegisterKeyMapping(action.command ?? action.id, action.label, 'keyboard', action.defaultKey);
}

// NUI Callback to toggle freelook
RegisterNuiCallbackType('toggleFreelook');
on('__cfx_nui:toggleFreelook', (data: { state: boolean }, cb: Function) => {
  if (PhoneState.isOpen()) {
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
  PhoneState.setTyping(Boolean(data?.typing));
  cb({});
});

// NUI Callback to close phone
RegisterNuiCallbackType('hideFrame');
on('__cfx_nui:hideFrame', (_: any, cb: Function) => {
  PhoneState.setOpen(false);
  PhoneState.setTyping(false);
  // Otherwise the scripted cam survives the phone closing and the player is stuck
  // looking through it.
  PhoneCamera.disable();

  const ped = PlayerPedId();
  PhoneAnimation.removePhoneProp();
  PhoneAnimation.stopAllPhoneAnimations(ped);
  Freelook.resetFreelook();

  sendNuiMessage('setVisible', false);
  cb({});
});

// NUI Callback for camera app animation state
RegisterNuiCallbackType('onCameraApp');
on('__cfx_nui:onCameraApp', async (data: { state: boolean }, cb: Function) => {
  const ped = PlayerPedId();
  const active = Boolean(data?.state);
  await PhoneAnimation.setCameraApp(ped, active, PhoneState.isOpen());

  // After the animation, so the prop exists and the hand is in position before the cam
  // attaches and hides it.
  if (active && PhoneState.isOpen()) {
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
  if (PhoneState.isOpen()) {
    sendTimeToNui();
  }
}, 1000);
