import { charge } from '../../shell/state/charge';
import {
  signalLevel,
  setSignal,
  cellServiceEnabled,
  toggleCellService
} from '../../shell/state/signal';
import {
  bluetoothEnabled,
  toggleBluetooth,
  isBluetoothDiscoverable
} from '../../shell/state/bluetooth';
import {
  soundVolume,
  soundMuted,
  setVolume,
  toggleMute,
  volumeStep,
  setVolumeStep,
  VOLUME_STEP_CHOICES
} from '../../shell/state/audio';

/**
 * The phone's hardware: battery, cellular signal, cell service, bluetooth, and volume controls.
 */
export function useSystemHardware() {
  return {
    charge,
    signalLevel,
    setSignal,
    cellServiceEnabled,
    toggleCellService,
    bluetoothEnabled,
    toggleBluetooth,
    isBluetoothDiscoverable,
    soundVolume,
    soundMuted,
    setVolume,
    toggleMute,
    /** How far one physical volume-button press moves the volume, in whole percent. */
    volumeStep,
    setVolumeStep,
    volumeStepChoices: VOLUME_STEP_CHOICES
  };
}
