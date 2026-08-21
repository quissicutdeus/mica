import { registerFacet } from '../../current';
import { onDestroy } from 'svelte';
import { remoteCall } from '../remote';

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

  const releasePromise = remoteCall<() => void>(
    'keybinds',
    [],
    'onKeybind',
    'back',
    back,
    config.appId.toLowerCase()
  );
  const release = () => void releasePromise.then((off) => off());
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
