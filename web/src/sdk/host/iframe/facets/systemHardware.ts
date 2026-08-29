import { registerFacet } from '../../current';
import type { Facets } from '../../inProcess/facets';
import { fn, store, type AsTwin } from './_shared';
import { constants } from '../constants';

type Twin = AsTwin<
  ReturnType<typeof import('../../inProcess/facets/systemHardware').systemHardware>
>;

export function systemHardware(): Twin {
  const c = constants().systemHardware;

  return {
    charge: store('systemHardware', [], 'charge', 100),
    signalLevel: store('systemHardware', [], 'signalLevel', 4),
    setSignal: fn('systemHardware', [], 'setSignal'),
    cellServiceEnabled: store('systemHardware', [], 'cellServiceEnabled', true),
    toggleCellService: fn('systemHardware', [], 'toggleCellService'),
    bluetoothEnabled: store('systemHardware', [], 'bluetoothEnabled', true),
    toggleBluetooth: fn('systemHardware', [], 'toggleBluetooth'),
    isBluetoothDiscoverable: store('systemHardware', [], 'isBluetoothDiscoverable', true),
    soundVolume: store('systemHardware', [], 'soundVolume', 0.5),
    soundMuted: store('systemHardware', [], 'soundMuted', false),
    setVolume: fn('systemHardware', [], 'setVolume'),
    toggleMute: fn('systemHardware', [], 'toggleMute'),
    volumeStep: store('systemHardware', [], 'volumeStep', 5),
    setVolumeStep: fn('systemHardware', [], 'setVolumeStep'),
    ringMode: store('systemHardware', [], 'ringMode', 'normal'),
    setRingMode: fn('systemHardware', [], 'setRingMode'),
    // Empty until the shell's first store reply lands, which is honest: the frame has not
    // been told the list yet. A constant would have to be hand-carried through
    // `AddOnConstants`, and nothing paints a ringer picker on the first frame.
    ringModeChoices: store('systemHardware', [], 'ringModeChoices', []),
    ringtone: store('systemHardware', [], 'ringtone', 'classic'),
    setRingtone: fn('systemHardware', [], 'setRingtone'),
    ringtoneChoices: store('systemHardware', [], 'ringtoneChoices', []),
    previewRingtone: fn('systemHardware', [], 'previewRingtone'),
    // Carried over the wire as `unknown` (`AddOnConstants`) — the shell can only promise
    // it hydrated whatever the inProcess side actually sent, not its literal shape.
    volumeStepChoices: c.volumeStepChoices as Twin['volumeStepChoices']
  };
}

// The Twin above is what an iframe can honestly offer (MICA-26) -- Readable in place of
// Writable, and (for the handful of members noted above) async where the wire makes
// something inProcess exposes synchronously. This is the one place that gap is bridged,
// once per facet, rather than a blanket cast hiding the whole object from the checker.
registerFacet('systemHardware', systemHardware as unknown as Facets['systemHardware']);
