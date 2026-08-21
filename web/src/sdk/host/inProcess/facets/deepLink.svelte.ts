import { registerFacet } from '../../current';
import { consumeAppProps } from '../../../../shell/state/navigation';

/**
 * Implementation of the `useDeepLink` facet — see the `useDeepLink` hook doc for the
 * usage contract (the residency rules on when `handle` runs and what its return means).
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
