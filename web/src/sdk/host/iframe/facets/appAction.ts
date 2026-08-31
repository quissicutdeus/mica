import type { AppActionOptions } from '../../facets';
import { registerFacet } from '../../current';
import type { Facets } from '../../facets';
import { writable } from 'svelte/store';
import { messageOf } from '../../../../lib/sdk/errors';
import { remoteCall } from '../remote';

type Twin = ReturnType<Facets['appAction']>;

// MICA-179: defined once in the host contract; re-exported so existing importers keep working.
export type { AppActionOptions } from '../../facets';
/** Implementation of the `useAppAction` facet — see the inProcess twin for the usage contract. */
export function appAction(appId?: string): Twin {
  const busy = writable(false);
  const factoryArgs = [appId];

  const notify = (n: { type: 'success' | 'error'; title?: string; message: string }) =>
    void remoteCall('appAction', factoryArgs, 'notify', n);

  const run = async (work: () => unknown, options: AppActionOptions = {}): Promise<boolean> => {
    busy.set(true);
    try {
      await work();
      if (options.success) {
        notify({ type: 'success', title: options.title, message: options.success });
      }
      return true;
    } catch (e) {
      console.error(options.error || 'App action failed', e);
      notify({
        type: 'error',
        title: options.title,
        message: options.error || messageOf(e, 'That did not work')
      });
      return false;
    } finally {
      busy.set(false);
    }
  };

  return { busy, run, notify } as unknown as Twin;
}

registerFacet('appAction', appAction);
