import { fetchNui } from '../nui/fetchNui';
import { useNuiEvent } from '../nui/useNuiEvent';

/**
 * OS Service Hook for the FiveM NUI transport.
 *
 * ## Why these are wrappers and not the functions themselves
 *
 * This used to return the imported functions directly, which made destructuring at module
 * scope quietly wrong:
 *
 * ```ts
 * const { fetchNui } = useNuiBridge();   // captures the transport as it is *right now*
 * ```
 *
 * That snapshot is taken when the module is imported. A test that later installs a spy on
 * the transport never sees it, so the store goes on talking to the real mock registry
 * while the test asserts against its own stubs — and the failure reads as wrong fixture
 * data rather than as a stale binding. It cost two passes to recognise while migrating
 * Blabber's store, which is a good sign it would cost an add-on author more.
 *
 * A wrapper makes the *wrapper* the stable thing and re-reads the module binding on every
 * call. So destructuring is now safe, at module scope or anywhere else — which is the
 * point: the ergonomic move and the correct move should be the same one. Telling every
 * app "do not destructure this" would be a rule waiting to be broken, and the SDK is
 * exactly the layer that should absorb that rather than export it.
 *
 * The cost is one function call per transport call, against a round trip to the game.
 */
export function useNuiBridge() {
  return {
    fetchNui: <T = unknown>(
      eventName: string,
      data?: unknown,
      options?: { defaultValue?: T }
    ): Promise<T> => fetchNui<T>(eventName, data, options),

    useNuiEvent: <T = unknown>(action: string, handler: (data: T) => void): (() => void) =>
      useNuiEvent<T>(action, handler)
  };
}
