<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { untrack, type Component } from 'svelte';
  import AddOnWidgetFrame from './addon/AddOnWidgetFrame.svelte';
  import type { WidgetEntry } from './state/widgets';
  import type { WidgetSize } from './state/homeGrid';

  let { entry, size } = $props<{ entry: WidgetEntry; size: WidgetSize }>();

  let loaded = $state<{ default: Component<{ size: WidgetSize; appId?: string }> } | null>(null);

  // The frame that runs a `core: false` add-on's widget is imported statically, like
  // `AddOnFrame` in `Shell.svelte`: a lazy import would split `srcdoc`'s imports into a chunk
  // the bundler evaluates ahead of the `persisted` facet, and the phone dies on boot.
  // A core app's widget is the manifest's own lazy `load`.
  //
  // Keyed on the widget's id, not the entry object: `availableWidgets` re-derives (a catalog
  // registration, a locale change) and hands over a fresh object for the same widget, and
  // reloading on identity blanked every widget on the home screen each time.
  const widgetId = $derived(entry.widgetId);
  $effect(() => {
    void widgetId;
    const render = untrack(() => entry.render);
    if (render.kind === 'addon') return;
    let live = true;
    loaded = null;
    render
      .load()
      .then((module: { default: unknown }) => {
        if (live) loaded = module as typeof loaded;
      })
      .catch(() => {
        // A widget that fails to load stays blank rather than taking the home screen with it.
      });
    return () => {
      live = false;
    };
  });

  let Widget = $derived(loaded?.default);
</script>

{#if entry.render.kind === 'addon'}
  <AddOnWidgetFrame appId={entry.render.appId} {size} />
{:else if Widget}
  <Widget {size} />
{/if}
