// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { registerFacet } from '../../current';
import type { Facets } from '../../facets';
import { store, type AsTwin } from './_shared';
import { constants } from '../constants';
import type { MotionPreference } from '../../../vocabulary/display';
import { DEFAULT_DEVICE, DEVICES, type DeviceId } from '@mica/shared/devices';

type Twin = AsTwin<ReturnType<Facets['display']>>;

export function display(): Twin {
  const c = constants().display;

  return {
    // MICA-260. The phone until the shell says otherwise, over the same subscribe path
    // as every store below; the live value is in the first push.
    device: store<DeviceId>('display', [], 'device', DEFAULT_DEVICE),
    frame: store('display', [], 'frame', DEVICES[DEFAULT_DEVICE].frame),
    displaySize: store('display', [], 'displaySize', c.displaySizeDefault ?? 50),
    displaySizeDefault: c.displaySizeDefault,
    phoneScale: store('display', [], 'phoneScale', 1),
    phoneBox: store('display', [], 'phoneBox', { width: 0, height: 0 }),
    isSizeLimited: store('display', [], 'isSizeLimited', false),

    // `AddOnConstants.display` is a `Record<string, number>` and this default is a string,
    // so it is stated here rather than carried over the wire. It is the shipped default and
    // changes only when `motion.ts` does; the live value arrives on the store above.
    motionPreference: store<MotionPreference>('display', [], 'motionPreference', 'system'),
    motionPreferenceDefault: 'system',
    reducedMotion: store('display', [], 'reducedMotion', false),

    homeGridColumns: store('display', [], 'homeGridColumns', c.homeGridColumnsDefault ?? 4),
    homeGridRows: store('display', [], 'homeGridRows', c.homeGridRowsDefault ?? 5),
    homeGridColumnsDefault: c.homeGridColumnsDefault,
    homeGridColumnsMin: c.homeGridColumnsMin,
    homeGridColumnsMax: c.homeGridColumnsMax,
    homeGridRowsDefault: c.homeGridRowsDefault,
    homeGridRowsMin: c.homeGridRowsMin,
    homeGridRowsMax: c.homeGridRowsMax
  };
}

// The Twin above is what an iframe can honestly offer (MICA-26) -- Readable in place of
// Writable, and (for the handful of members noted above) async where the wire makes
// something inProcess exposes synchronously. This is the one place that gap is bridged,
// once per facet, rather than a blanket cast hiding the whole object from the checker.
registerFacet('display', display as unknown as Facets['display']);
