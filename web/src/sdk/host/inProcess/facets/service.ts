import { registerFacet } from '../../current';
import { fetchNui } from '../../../../nui/fetchNui';
import { GENERIC_SERVICE_ACTION } from '@shared/rpc';

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
     * `defaultValue` behaves as it does everywhere else in the SDK: a failed round trip
     * resolves to it rather than throwing, so a missing server half degrades to an empty
     * list instead of a crashed app. Omit it when a failure should surface — a write
     * wrapped in `useAppAction` wants the error so it can toast it.
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
