import { charge } from '../../shell/state/charge';
import { signalLevel, setSignal } from '../../shell/state/signal';
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
 * The phone's hardware: battery, signal, and the volume buttons.
 *
 * The time format used to be here too. It is a locale preference rather than hardware,
 * and it now lives in `useClock` with the clock it formats.
 */
export function useSystemHardware() {
  return {
    charge,
    signalLevel,
    setSignal,
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
