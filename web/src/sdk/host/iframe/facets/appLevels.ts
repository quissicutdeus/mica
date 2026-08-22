import { registerFacet } from '../../current';
import { onDestroy } from 'svelte';
import { remoteCall } from '../remote';
import { clientTransport } from '../transport';

type Twin = ReturnType<typeof import('../../inProcess/facets/appLevels').appLevels>;

interface AppLevel {
  open: () => boolean;
  close: () => void;
  title?: string | (() => string);
}

export interface AppLevelsConfig {
  appId: string;
  title: string | (() => string);
  onback?: () => void;
  levels: AppLevel[];
}

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
  } as unknown as Twin;
}

registerFacet('appLevels', appLevels);
