import { charge } from '../../store/charge';
import { signalLevel, setSignal } from '../../store/signal';
import { soundVolume, soundMuted, setVolume, toggleMute } from '../../store/sound';
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
    is24Hour
  };
}
