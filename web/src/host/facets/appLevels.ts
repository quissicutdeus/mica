// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { AppLevelsConfig } from '../../../../sdk/host/facets';
import { registerFacet } from '../../../../sdk/host/current';
import { onDestroy } from 'svelte';
import { registerHandler } from '../../shell/state/keybinds';

// MICA-179: defined once in the host contract; re-exported so existing importers keep working.
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
