import { isBrowser } from './isBrowser';
import { getTransport } from '../core/bridge/transport';

/**
 * Simple wrapper around fetch API tailored for CEF/NUI use.
 * Delegates transport execution to active transport adapter (CEF vs Mock).
 * @param eventName - The endpoint eventname to target
 * @param data - Data you wish to send in the NUI Callback
 * @param options - Options for the request, including default value for safety
 * @return returnData - A promise for the data sent back by the Nui Callbacks
 */
export async function fetchNui<T = any>(
  eventName: string,
  data?: any,
  options?: { defaultValue?: T }
): Promise<T> {
  try {
    const respFormatted = await getTransport().send<T>(eventName, data);

    if (options?.defaultValue !== undefined) {
      if (respFormatted === null || respFormatted === undefined) {
        return options.defaultValue;
      }
      if (Array.isArray(options.defaultValue) && !Array.isArray(respFormatted)) {
        return options.defaultValue;
      }
    }

    return respFormatted ?? options?.defaultValue ?? (null as unknown as T);
  } catch {
    if (options?.defaultValue !== undefined) {
      return options.defaultValue;
    }
    return null as unknown as T;
  }
}

export { isBrowser };
