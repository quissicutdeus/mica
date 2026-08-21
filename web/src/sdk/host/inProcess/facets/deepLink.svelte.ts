import { registerFacet } from '../../current';
import { consumeAppProps } from '../../../../shell/state/navigation';

/**
 * OS Service Hook for acting on the props a deep link opened this app with.
 *
 * Three apps had written the same effect, and the same paragraph explaining it, because
 * the rule it encodes is not guessable. Apps stay resident, so:
 *
 * - It cannot be mount-time work. Mount runs once per session, so a second tap on the
 *   camera thumbnail would be ignored.
 * - It has to consume the props. They are still set when the user presses back, so an
 *   unconsumed link re-fires and the back button looks dead.
 * - It has to be able to wait. On a cold open the list has not arrived yet, so the link
 *   must survive until the data it names exists.
 *
 * `handle` returns whether it acted. Returning `false` leaves the props in place to be
 * tried again on the next change — which is what makes the third rule work — and `true`
 * clears them.
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
 *
 * A rune file rather than a plain module: the handler reads props and stores, and only
 * an effect re-runs when those change.
 */
export function deepLink(appId: string, handle: () => boolean): void {
  $effect(() => {
    if (handle()) consumeAppProps(appId);
  });
}

registerFacet('deepLink', deepLink);
