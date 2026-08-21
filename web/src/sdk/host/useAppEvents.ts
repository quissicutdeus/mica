import './inProcess/facets/appEvents';
import { guarded } from './guard';

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
  return guarded('useAppEvents', appId).facets.appEvents(appId);
}
