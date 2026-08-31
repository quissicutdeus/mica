import type { AppLevelsConfig } from '../../facets';
import { registerFacet } from '../../current';
import type { Facets } from '../../facets';
import type { AsTwin } from './_shared';
import { onDestroy } from 'svelte';
import { remoteCall } from '../remote';
import { clientTransport } from '../transport';

type Twin = AsTwin<ReturnType<Facets['appLevels']>>;

// MICA-179: defined once in the host contract; re-exported so existing importers keep working.
export type { AppLevelsConfig } from '../../facets';
const resolve = (title: string | (() => string) | undefined): string =>
  typeof title === 'function' ? title() : (title ?? '');

/** Implementation of the `useAppLevels` facet — see the inProcess twin for the usage contract. */
export function appLevels(config: AppLevelsConfig): Twin {
  const back = () => {
    const level = config.levels.find((l) => l.open());
    if (level) level.close();
    else config.onback?.();
  };

  // A direct `remoteCall` rather than the `lifecycle` twin helper (MICA-27): the twin's
  // `onBack` is cast to the inProcess (synchronous) return shape, but the value crossing
  // the wall really is a promise, and `release` below needs to `.then()` it.
  const releasePromise = remoteCall<() => void>('lifecycle', [config.appId], 'onBack', back);
  // MICA-23: `back` also still lives in this frame's own callback map until dropped here.
  const release = () => {
    void releasePromise.then((off) => off());
    clientTransport().releaseCallback(back);
  };
  try {
    onDestroy(release);
  } catch {
    // Called outside a component lifecycle; the caller owns cleanup.
  }

  return {
    back,
    release,
    get title(): string {
      const level = config.levels.find((l) => l.open() && l.title !== undefined);
      return level ? resolve(level.title) : resolve(config.title);
    }
  };
}

// The Twin above is what an iframe can honestly offer (MICA-26) -- Readable in place of
// Writable, and (for the handful of members noted above) async where the wire makes
// something inProcess exposes synchronously. This is the one place that gap is bridged,
// once per facet, rather than a blanket cast hiding the whole object from the checker.
registerFacet('appLevels', appLevels);
