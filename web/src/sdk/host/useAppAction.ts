import './inProcess/facets/appAction';
import { guarded } from './guard';
export type { AppActionOptions } from './inProcess/facets/appAction';

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
 * const { busy, run } = useAppAction('contacts');
 *
 * const save = async () => {
 *   if (await run(() => contacts.update(draft), { success: 'Contact updated' })) {
 *     isEditing = false;
 *   }
 * };
 * ```
 */
export function useAppAction(appId?: string) {
  return guarded('useAppAction', appId).facets.appAction(appId);
}
