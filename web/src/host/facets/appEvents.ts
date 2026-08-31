import { registerFacet } from '../../sdk/host/current';
import { onDestroy } from 'svelte';
import { clearAppEvents, subscribeAppEvent } from '../../shell/state/appEvents';
import type { AppEvent } from '@gphone/sdk';

/** Implementation of the `useAppEvents` facet — see the `useAppEvents` hook doc for the usage contract. */
export function appEvents(appId: string) {
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

registerFacet('appEvents', appEvents);
