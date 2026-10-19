// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { registerFacet } from '../../../../sdk/host/current';
import { fetchNui } from '../../nui/fetchNui';
import { GENERIC_SERVICE_ACTION } from '@mica/shared/rpc';

/**
 * Implementation of the `useService` facet — see the `useService` hook doc for the usage
 * contract (what this does and does not change, whose service an id may name).
 */
export function service(serviceId: string) {
  return {
    id: serviceId,

    /**
     * Call one action and wait for the reply.
     *
     * `defaultValue` behaves as it does in `fetchNui`: a failed round trip resolves to it
     * rather than throwing. Pass one only for a value whose absence is itself an answer,
     * never to hide a failed round trip. A list read that fails must reject rather than
     * come back empty, or the player is told they have none (MICA-384). Omit it for every
     * write, since `useAppAction` needs the error to toast it, and for any read whose empty
     * answer means something.
     */
    call: <T = unknown>(action: string, data?: unknown, defaultValue?: T): Promise<T> =>
      fetchNui<T>(
        GENERIC_SERVICE_ACTION,
        { service: serviceId, action, data },
        defaultValue === undefined ? undefined : { defaultValue }
      )
  };
}

registerFacet('service', service);
