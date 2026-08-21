import { onDestroy } from 'svelte';
import { clearAppEvents, subscribeAppEvent, type AppEvent } from '../../shell/state/appEvents';
import { assertCapability } from '../capability';

/**
 * OS Service Hook for events the server pushes to this app.
 *
 * `appId` is required for the same reason `useAppLevels` and `onAppForeground` require it: the
 * shell has no way to hand a component its own registry id (§2.7).
 *
 * **Where you call this decides whether it can miss anything.** At module scope — in the app's
 * store, which the registry imports before anything mounts — the subscription is permanent and
 * survives the phone closing, which is what a `badgeStore` has to be fed from. Inside a
 * component it lives as long as the component, and anything that arrived while it was unmounted
 * is replayed on subscribe.
 *
 * One direction only. Apps write through `useAppAction` and a declared route, unchanged.
 */
export function useAppEvents(appId: string) {
  assertCapability('app-events', 'useAppEvents');
  const app = appId.toLowerCase();

  const listen = (event: string, handler: (e: AppEvent) => void): (() => void) => {
    const unsubscribe = subscribeAppEvent(app, event, handler);
    try {
      // Matches `onAppForeground`: dispose with the component when there is one, and be a
      // permanent subscription when there is not.
      onDestroy(unsubscribe);
    } catch {
      // Called outside a component. Deliberate — that is the module-scope case.
    }
    return unsubscribe;
  };

  return {
    /**
     * `T` is an **assertion, not a check**. The bus guarantees `payload` is a plain object and
     * nothing more; narrow it yourself.
     */
    on: <T = Record<string, unknown>>(event: string, handler: (e: AppEvent<T>) => void) =>
      listen(event, handler as (e: AppEvent) => void),
    onAny: (handler: (e: AppEvent) => void) => listen('*', handler),
    /** Drop anything buffered, once a fetch has made it redundant. */
    clear: () => clearAppEvents(app)
  };
}
