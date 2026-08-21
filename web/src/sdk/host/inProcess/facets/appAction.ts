import { registerFacet } from '../../current';
import { writable } from 'svelte/store';
import { toast } from '../../../../shell/state/toast';
import { messageOf } from '../../../../lib/errors';

export interface AppActionOptions {
  /** Toast to show when the work succeeds. Omit for actions that speak for themselves. */
  success?: string;
  /** Toast to show when it throws. Defaults to the error's own message. */
  error?: string;
  /** Heading on both toasts, for an app that names itself in its notifications. */
  title?: string;
}

/** Implementation of the `useAppAction` facet — see the `useAppAction` hook doc for the usage contract. */
export function appAction(appId?: string) {
  const busy = writable(false);

  const run = async (
    work: () => Promise<unknown> | unknown,
    options: AppActionOptions = {}
  ): Promise<boolean> => {
    busy.set(true);
    try {
      await work();
      if (options.success) {
        toast.show({ type: 'success', app: appId, title: options.title, message: options.success });
      }
      return true;
    } catch (e) {
      console.error(options.error || 'App action failed', e);
      toast.show({
        type: 'error',
        app: appId,
        title: options.title,
        message: options.error || messageOf(e, 'That did not work')
      });
      return false;
    } finally {
      busy.set(false);
    }
  };

  return { busy, run };
}

registerFacet('appAction', appAction);
