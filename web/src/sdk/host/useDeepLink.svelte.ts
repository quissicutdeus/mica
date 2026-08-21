import './inProcess/facets/deepLink.svelte';
import { guarded } from './guard';

/**
 * OS Service Hook for acting on the props a deep link opened this app with.
 *
 * ```ts
 * useDeepLink('media', () => {
 *   if (initialPhoto) { selectedPhoto = initialPhoto; return true; }
 *   const found = initialPhotoId && $photos.find((p) => p.id === initialPhotoId);
 *   if (!found) return false;   // not loaded yet — ask again when it is
 *   selectedPhoto = found;
 *   return true;
 * });
 * ```
 */
export function useDeepLink(appId: string, handle: () => boolean): void {
  guarded('useDeepLink', appId).facets.deepLink(appId, handle);
}
