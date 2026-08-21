import { registerFacet } from '../../current';
import { remoteCall } from '../remote';

/**
 * Implementation of the `useDeepLink` facet — see the inProcess twin for the usage
 * contract. A rune file rather than a plain module, like its inProcess counterpart: the
 * handler reads props and stores, and only an effect re-runs when those change.
 */
export function deepLink(appId: string, handle: () => boolean): void {
  $effect(() => {
    if (handle()) void remoteCall('navigation', [], 'consumeDeepLink', appId);
  });
}

registerFacet('deepLink', deepLink);
