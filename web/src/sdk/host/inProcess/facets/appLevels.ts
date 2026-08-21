import { registerFacet } from '../../current';
import { onDestroy } from 'svelte';
import { registerHandler } from '../../../../shell/state/keybinds';

interface AppLevel {
  /** True while this level is on screen. */
  open: () => boolean;
  /** Take it off screen. Runs when back is pressed and this is the deepest open level. */
  close: () => void;
  /** Header title while this is the deepest open level. */
  title?: string | (() => string);
}

export interface AppLevelsConfig {
  /**
   * The app's registry id — `notes`, `settings`. Not its display name.
   *
   * Required, and it is what stops Back reaching a backgrounded app. Apps are resident,
   * so this ladder stays registered while the app sits hidden; without an owner the
   * dispatcher would hand `back` to whichever app registered last rather than the one on
   * screen. The app names itself for the same reason it does in `onAppForeground`: the
   * shell has no way to hand a component its own registry id.
   */
  appId: string;
  /** Title when nothing is open — the app's own name, usually. */
  title: string | (() => string);
  /** Where back goes once every level is closed. The shell's `onback` prop. */
  onback?: () => void;
  /** Deepest first. Back closes the first one that is open. */
  levels: AppLevel[];
}

const resolve = (title: string | (() => string) | undefined): string =>
  typeof title === 'function' ? title() : (title ?? '');

/**
 * Implementation of the `useAppLevels` facet — see the `useAppLevels` hook doc for the
 * usage contract (the two-things-have-to-happen and appId-stops-Back rules).
 */
export function appLevels(config: AppLevelsConfig) {
  const back = () => {
    const level = config.levels.find((l) => l.open());
    if (level) level.close();
    else config.onback?.();
  };

  const release = registerHandler('back', back, config.appId.toLowerCase());
  try {
    onDestroy(release);
  } catch {
    // Called outside a component lifecycle; the caller owns cleanup.
  }

  return {
    back,
    release,
    /** The deepest open level's title, falling back to the app's own. */
    get title(): string {
      const level = config.levels.find((l) => l.open() && l.title !== undefined);
      return level ? resolve(level.title) : resolve(config.title);
    }
  };
}

registerFacet('appLevels', appLevels);
