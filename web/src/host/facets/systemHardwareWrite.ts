import { registerFacet } from '../../sdk/host/current';
import { charge } from '../../shell/state/charge';
import { setSignal, toggleCellService } from '../../shell/state/signal';
import { toggleBluetooth } from '../../shell/state/bluetooth';
import {
  setVolume,
  toggleMute,
  setVolumeStep,
  setRingMode,
  setRingtone,
  audio
} from '../../shell/state/audio';
import type { RingtoneId } from '../../sdk/vocabulary/audio';

/**
 * Implementation of the `useSystemHardwareWrite` facet — see the `useSystemHardwareWrite`
 * hook doc for the usage contract. Split out of `systemHardware` (MICA-127): reading the
 * battery, signal and volume and actually changing them — including faking a battery level,
 * which Developer Tools does — are not the same ask.
 */
export function systemHardwareWrite() {
  return {
    /**
     * Developer Tools' battery slider used to call `charge.set()` directly; that bypassed
     * this permission entirely, the same gap `useClockWrite`'s `setIs24Hour` closed for
     * `is24Hour`.
     */
    setCharge: (level: number): void => {
      charge.set(level);
    },
    setSignal,
    toggleCellService,
    toggleBluetooth,
    setVolume,
    toggleMute,
    setVolumeStep,
    setRingMode,
    setRingtone,
    /**
     * Audition a tone from the settings pane. Ignores the ring mode (that is the control
     * being configured) but not the mute or the volume — see `SoundService.preview`.
     */
    previewRingtone: (id: RingtoneId) => audio.preview(id)
  };
}

registerFacet('systemHardwareWrite', systemHardwareWrite);
