// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { derived, type Readable } from 'svelte/store';
import { t } from '../messages';
import { appVisible } from './appVisibility';
import { appRegistryStore } from './registry';
import type { WidgetSize } from './homeGrid';

/**
 * How a widget draws itself (MICA-245). A built-in and a core app's widget are components
 * in this document; a `core: false` add-on's is a frame — the add-on's own sandboxed
 * bundle — so its `render` names the app and `WidgetHost` mounts `AddOnWidgetFrame`.
 * Both are loaded lazily, like an app's component, so a home screen with no widgets on it
 * parses none of them.
 */
export type WidgetRender =
  | { kind: 'component'; load: () => Promise<{ default: unknown }> }
  | { kind: 'addon'; appId: string };

export interface WidgetEntry {
  widgetId: string;
  label: string;
  sizes: WidgetSize[];
  render: WidgetRender;
}

// Eager, and that is not a preference. A dynamic import of a widget makes its own imports
// (`state/time`, `state/charge`, `state/airplane`) shared chunks that the bundler must order
// against the SDK chunk, and those modules read the `persisted` facet at evaluation: the
// chunk cycle evaluates them before `registerFacets` has run, and the phone dies on boot
// with "host facet 'persisted' is not loaded". Static imports keep the order `main.ts`
// gives them. The built-ins are two small components, so nothing is spent that matters.
const builtInFiles = import.meta.glob<{ default: unknown }>('../widgets/*.svelte', { eager: true });
const builtIn = (name: string): (() => Promise<{ default: unknown }>) | undefined => {
  const module = builtInFiles[`../widgets/${name}.svelte`];
  return module && (() => Promise.resolve(module));
};

const BOTH: WidgetSize[] = ['2x1', '2x2'];

/**
 * Every widget that could be placed right now: the shell's own, plus one per installed,
 * visible app whose manifest declares `widget`. `appVisible` is the same rule the icon
 * grid uses, so an owner-disabled or `requires`-unmet app offers no widget either — and a
 * placed widget whose entry vanishes is hidden, never deleted (`homeGrid.ts`).
 */
export const availableWidgets: Readable<WidgetEntry[]> = derived(
  [appRegistryStore, appVisible, t],
  ([$apps, $visible, $t]) => {
    const entries: WidgetEntry[] = [];
    const clock = builtIn('Clock');
    if (clock) {
      entries.push({
        widgetId: 'shell.clock',
        label: $t('shell.widgetClock'),
        sizes: BOTH,
        render: { kind: 'component', load: clock }
      });
    }
    const status = builtIn('Status');
    if (status) {
      entries.push({
        widgetId: 'shell.status',
        label: $t('shell.widgetStatus'),
        sizes: BOTH,
        render: { kind: 'component', load: status }
      });
    }
    for (const manifest of $apps) {
      const widget = manifest.widget;
      if (!widget || widget.sizes.length === 0 || !$visible(manifest)) continue;
      entries.push({
        widgetId: manifest.id,
        label: manifest.name,
        sizes: [...widget.sizes],
        render:
          manifest.core && widget.load
            ? { kind: 'component', load: widget.load }
            : { kind: 'addon', appId: manifest.id }
      });
    }
    return entries;
  }
);
