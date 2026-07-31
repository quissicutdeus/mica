import './controllers';
import { sendChargeToNui } from './controllers/BatteryController';
import { FrameworkBridge } from './lib/FrameworkBridge';
import { sendNuiMessage } from './lib/NuiUtils';
import { PhoneAnimationController } from './controllers/PhoneAnimationController';
import { FreelookController } from './controllers/FreelookController';

let isPhoneOpen = false;

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
    isPhoneOpen = !isPhoneOpen;

    if (isPhoneOpen) {
      SetNuiFocus(true, true);
      sendNuiMessage('setVisible', true);

      const ped = PlayerPedId();
      PhoneAnimationController.playAppAnimation(ped, null, isPhoneOpen);
      PhoneAnimationController.spawnPhoneProp(ped, isPhoneOpen);

      // Send time and battery charge immediately when opening
      sendTimeToNui();
      sendChargeToNui();
    } else {
      const ped = PlayerPedId();
      PhoneAnimationController.removePhoneProp();
      PhoneAnimationController.stopAllPhoneAnimations(ped);
      FreelookController.resetFreelook();

      sendNuiMessage('setVisible', false);
    }
  },
  false
);

// Register Key Mapping
RegisterKeyMapping('togglePhone', 'Open Phone', 'keyboard', 'm');

// NUI Callback to toggle freelook
RegisterNuiCallbackType('toggleFreelook');
on('__cfx_nui:toggleFreelook', (data: { state: boolean }, cb: Function) => {
  if (isPhoneOpen) {
    if (data && data.state) {
      FreelookController.enableFreelook();
    } else {
      FreelookController.disableFreelook();
    }
  }
  cb({});
});

// NUI Callback to close phone
RegisterNuiCallbackType('hideFrame');
on('__cfx_nui:hideFrame', (_: any, cb: Function) => {
  isPhoneOpen = false;

  const ped = PlayerPedId();
  PhoneAnimationController.removePhoneProp();
  PhoneAnimationController.stopAllPhoneAnimations(ped);
  FreelookController.resetFreelook();

  sendNuiMessage('setVisible', false);
  cb({});
});

// NUI Callback for camera app animation state
RegisterNuiCallbackType('onCameraApp');
on('__cfx_nui:onCameraApp', async (data: { state: boolean }, cb: Function) => {
  const ped = PlayerPedId();
  await PhoneAnimationController.setCameraApp(ped, Boolean(data?.state), isPhoneOpen);
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
  if (isPhoneOpen) {
    sendTimeToNui();
  }
}, 1000);
