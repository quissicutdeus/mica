import { charge } from '../../store/charge';
import { signalLevel, setSignal } from '../../store/signal';
import {
  soundVolume,
  soundMuted,
  setVolume,
  toggleMute,
  volumeStep,
  setVolumeStep,
  VOLUME_STEP_CHOICES
} from '../../store/sound';
import { is24Hour } from '../../store/time';

/**
 * OS Service Hook for system hardware state (battery, signal, volume, time format).
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
    volumeStepChoices: VOLUME_STEP_CHOICES,
    is24Hour
  };
}
