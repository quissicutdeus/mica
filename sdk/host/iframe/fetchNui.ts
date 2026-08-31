import { registerNuiTransport } from '../../nui/transport';
import { GENERIC_SERVICE_ACTION } from '@gphone/shared/rpc';
import { remoteCall } from './remote';

// MICA-16 step 4: the alias target for `src/nui/fetchNui.ts` in the add-on build.

/**
 * The add-on bundle's `fetchNui`. Only the generic service route exists on this side of the
 * wall, and it is routed through the `service` facet so the shell pins the id to the app's
 * namespace. A named NUI action — every core route — is refused here before it is even sent.
 */
export async function fetchNui<T = unknown>(
  eventName: string,
  data?: unknown,
  options?: { defaultValue?: T; quiet?: boolean }
): Promise<T> {
  if (eventName !== GENERIC_SERVICE_ACTION) {
    throw new Error(`[gPhone] add-ons cannot call NUI action '${eventName}'; use useService().`);
  }
  const {
    service,
    action,
    data: payload
  } = data as { service: string; action: string; data?: unknown };
  try {
    return await remoteCall<T>('service', [service], 'call', action, payload);
  } catch (e) {
    if (options?.defaultValue !== undefined) return options.defaultValue;
    throw e;
  }
}

/**
 * MICA-172: the add-on side of the transport seam. `bootAddOn` imports this module, which
 * is how a sandboxed bundle says `fetchNui` means the `postMessage` twin rather than CEF.
 */
registerNuiTransport((...args) => fetchNui(...args));
