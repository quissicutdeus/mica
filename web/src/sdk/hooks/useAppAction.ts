import { writable } from 'svelte/store';
import { toast } from '../../shell/state/toast';
import { messageOf } from '../../lib/errors';

export interface AppActionOptions {
  /** Toast to show when the work succeeds. Omit for actions that speak for themselves. */
  success?: string;
  /** Toast to show when it throws. Defaults to the error's own message. */
  error?: string;
  /** Heading on both toasts, for an app that names itself in its notifications. */
  title?: string;
}

/**
 * OS Service Hook for running one user-initiated action.
 *
 * Every app does the same four things around a write: mark itself busy so the button
 * cannot be pressed twice, await it, say whether it worked, and clear the busy flag
 * whatever happened. Admin was the only place that did all four. Contacts wrote the
 * shape out four times and the fourth — deleting a contact — silently dropped both
 * toasts, so a delete the server refused looked exactly like one that succeeded.
 *
 * `busy` is a store rather than component state so that one action can disable a whole
 * form, and so this can live in a plain module.
 *
 * `run` resolves to whether the work succeeded, which is what callers actually branch
 * on — close the editor, clear the draft — instead of putting that follow-up inside the
 * `try` where a failure would skip it by accident.
 *
 * ```svelte
 * const { busy, run } = useAppAction();
 *
 * const save = async () => {
 *   if (await run(() => contacts.update(draft), { success: 'Contact updated' })) {
 *     isEditing = false;
 *   }
 * };
 * ```
 */
export function useAppAction() {
  const busy = writable(false);

  const run = async (
    work: () => Promise<unknown> | unknown,
    options: AppActionOptions = {}
  ): Promise<boolean> => {
    busy.set(true);
    try {
      await work();
      if (options.success) {
        toast.show({ type: 'success', title: options.title, message: options.success });
      }
      return true;
    } catch (e) {
      console.error(options.error || 'App action failed', e);
      toast.show({
        type: 'error',
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
