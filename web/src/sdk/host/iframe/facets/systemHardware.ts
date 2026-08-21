import { registerFacet } from '../../current';
import { fn, store } from './_shared';
import { constants } from '../constants';

type Twin = ReturnType<typeof import('../../inProcess/facets/systemHardware').systemHardware>;

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
    volumeStepChoices: c.volumeStepChoices
  } as unknown as Twin;
}

registerFacet('systemHardware', systemHardware);
