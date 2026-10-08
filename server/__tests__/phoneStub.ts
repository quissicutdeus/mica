// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { __setPhoneResolvers } from '../lib/phoneIdentity';

/**
 * The phone every server suite is on unless it says otherwise (MICA-282).
 *
 * `ServiceEndpoint` asks `lib/phoneIdentity.ts` which phone a device-owned request is for,
 * and in production `services/Phones.ts` answers from the item in the caller's inventory. A
 * suite that imports one service without the barrel has no answer installed, and the seam
 * throws rather than guessing — so `setup.ts` installs this one for everybody. A suite about
 * the resolution itself (`phones.test.ts`, `phoneNumbers.test.ts`) imports the real service,
 * which re-installs the real resolvers over these at import.
 */
export const TEST_PHONE_ID = '0123456789abcdef0123456789abcdef';

/**
 * The tablet's answer (MICA-264): a request that names the tablet is on an identity of its own,
 * so a suite that drives one sees a different id from the phone's. The device check passes for
 * every device here; a suite about the check installs its own.
 */
export const TEST_TABLET_ID = 'fedcba9876543210fedcba9876543210';

export const installTestPhone = (): void => {
  __setPhoneResolvers({
    forRequest: async (_src, _citizenid, device = 'phone') =>
      device === 'tablet' ? TEST_TABLET_ID : TEST_PHONE_ID,
    forCitizen: async () => TEST_PHONE_ID,
    deviceInHand: () => undefined
  });
};
