import { readable } from 'svelte/store';
import { registerFacet } from '../../current';
import { charge } from '../../../../shell/state/charge';
import {
  signalLevel,
  setSignal,
  cellServiceEnabled,
  toggleCellService
} from '../../../../shell/state/signal';
import {
  bluetoothEnabled,
  toggleBluetooth,
  isBluetoothDiscoverable
} from '../../../../shell/state/bluetooth';
import {
  soundVolume,
  soundMuted,
  setVolume,
  toggleMute,
  volumeStep,
  setVolumeStep,
  VOLUME_STEP_CHOICES,
  ringMode,
  setRingMode,
  RING_MODE_CHOICES,
  ringtone,
  setRingtone,
  RINGTONE_OPTIONS,
  audio,
  type RingtoneId
} from '../../../../shell/state/audio';

/**
 * The phone's hardware: battery, cellular signal, cell service, bluetooth, volume controls,
 * and the ringer switch beside them.
 */
export function systemHardware() {
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
    volumeStepChoices: VOLUME_STEP_CHOICES,
    /** The ringer switch: `'normal' | 'vibrate' | 'silent'`. MICA-62. */
    ringMode,
    setRingMode,
    /**
     * The choice lists are `readable` wrappers rather than the bare arrays, and that is a
     * transport decision, not a second source of truth — `shell/state/audio.ts` still owns
     * the one list. A plain value on a facet has to be hand-carried through
     * `AddOnConstants` (as `volumeStepChoices` is, because the first paint needs it
     * synchronously); a store rides the generic subscribe path an iframe twin already has.
     * Nothing renders a ringer picker before hydration, so the store is the cheaper half
     * of that trade.
     */
    ringModeChoices: readable(RING_MODE_CHOICES),
    ringtone,
    setRingtone,
    ringtoneChoices: readable(RINGTONE_OPTIONS),
    /**
     * Audition a tone from the settings pane. Ignores the ring mode (that is the control
     * being configured) but not the mute or the volume — see `SoundService.preview`.
     */
    previewRingtone: (id: RingtoneId) => audio.preview(id)
  };
}

registerFacet('systemHardware', systemHardware);
