<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts" module>
  export interface MapPin {
    id: string;
    kind: 'self' | 'place' | 'friend';
    x: number;
    y: number;
    label: string;
  }
</script>

<script lang="ts">
  import type { Snippet } from 'svelte';
  import { LocationIcon, useLocale } from '@mica/sdk';
  import type { MapBounds } from '@mica/shared/contracts/places';
  import {
    FOCUS_ZOOM_FACTOR,
    MAP_SIZE,
    centreOn,
    clampView,
    fitView,
    minZoom,
    renderScale,
    toScreen,
    worldToMap,
    zoomAround,
    type MapView
  } from './mapProjection';

  /**
   * The map canvas (MICA-244): an SVG, so the grid, the owner's image and every pin are
   * attributes rather than CSS, and nothing here leans on a feature Chromium 103 lacks.
   *
   * micaOS ships no map picture — the game's own is not licensable under the AGPL — so with
   * no `mica_map_image` set this draws a neutral grid in the same square the image would fill.
   * Pins are drawn outside the zoomed group, so they stay one size at every zoom.
   */
  let {
    image,
    bounds,
    pins,
    actions
  }: {
    image: string | null;
    bounds: MapBounds;
    pins: MapPin[];
    /** Drawn top-left over the map, beside the zoom controls. */
    actions?: Snippet;
  } = $props();

  const { t } = useLocale();

  let element: HTMLDivElement | undefined = $state();
  let width = $state(0);
  let height = $state(0);
  /** Null until the player moves the map; until then the view follows `initialView`. */
  let moved: MapView | null = $state(null);

  const self = $derived(pins.find((pin) => pin.kind === 'self'));

  const initialView = $derived.by((): MapView => {
    if (!self) return fitView(width, height);
    const { mx, my } = worldToMap(self.x, self.y, bounds);
    return centreOn(mx, my, minZoom(width, height) * FOCUS_ZOOM_FACTOR, width, height);
  });

  const view = $derived(moved ?? initialView);
  const ready = $derived(width > 0 && height > 0);

  const placed = $derived(
    pins.map((pin) => {
      const { mx, my } = worldToMap(pin.x, pin.y, bounds);
      return { ...pin, ...toScreen(mx, my, view) };
    })
  );

  let drag: { id: number; x: number; y: number; from: MapView; scale: number } | null = null;

  const onpointerdown = (event: PointerEvent) => {
    if (!element || event.button !== 0) return;
    element.setPointerCapture(event.pointerId);
    drag = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      from: view,
      scale: renderScale(element)
    };
  };

  const onpointermove = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.id) return;
    moved = clampView(
      {
        k: drag.from.k,
        tx: drag.from.tx + (event.clientX - drag.x) / drag.scale,
        ty: drag.from.ty + (event.clientY - drag.y) / drag.scale
      },
      width,
      height
    );
  };

  const endDrag = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.id) return;
    drag = null;
    if (element?.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
  };

  const zoomBy = (factor: number) => {
    moved = zoomAround(view, factor, width / 2, height / 2, width, height);
  };

  const recentre = () => {
    moved = null;
  };

  /**
   * Wheel zoom around the pointer. An action rather than `onwheel`, so the listener can be
   * registered non-passive and `preventDefault` keeps the screen behind it from scrolling.
   */
  const wheelZoom = (node: HTMLElement) => {
    const handle = (event: WheelEvent) => {
      event.preventDefault();
      const rect = node.getBoundingClientRect();
      const scale = renderScale(node);
      const px = (event.clientX - rect.left) / scale;
      const py = (event.clientY - rect.top) / scale;
      moved = zoomAround(view, event.deltaY < 0 ? 1.25 : 0.8, px, py, width, height);
    };
    node.addEventListener('wheel', handle, { passive: false });
    return { destroy: () => node.removeEventListener('wheel', handle) };
  };
</script>

<div class="relative flex min-h-0 flex-1 flex-col">
  <div
    bind:this={element}
    bind:clientWidth={width}
    bind:clientHeight={height}
    use:wheelZoom
    class="bg-surface-container-high relative min-h-0 flex-1 touch-none overflow-hidden select-none"
    role="application"
    aria-label={$t('places.mapLabel')}
    data-testid="places-map"
    {onpointerdown}
    {onpointermove}
    onpointerup={endDrag}
    onpointercancel={endDrag}
  >
    {#if ready}
      <svg class="absolute inset-0" {width} {height} aria-hidden="true">
        <defs>
          <pattern id="places-grid" width="50" height="50" patternUnits="userSpaceOnUse">
            <path
              d="M 50 0 L 0 0 0 50"
              fill="none"
              stroke="currentColor"
              stroke-opacity="0.25"
              stroke-width="1"
            />
          </pattern>
        </defs>
        <g transform="translate({view.tx} {view.ty}) scale({view.k})">
          {#if image}
            <image
              href={image}
              width={MAP_SIZE}
              height={MAP_SIZE}
              preserveAspectRatio="none"
              data-testid="places-map-image"
            />
          {:else}
            <g class="text-on-surface-variant" data-testid="places-map-grid">
              <rect width={MAP_SIZE} height={MAP_SIZE} fill="url(#places-grid)" />
              <rect
                width={MAP_SIZE}
                height={MAP_SIZE}
                fill="none"
                stroke="currentColor"
                stroke-opacity="0.5"
                stroke-width={2 / view.k}
              />
            </g>
          {/if}
        </g>
      </svg>

      <svg class="pointer-events-none absolute inset-0" {width} {height}>
        {#each placed as pin (pin.id)}
          <g
            class={pin.kind === 'self'
              ? 'text-primary'
              : pin.kind === 'place'
                ? 'text-secondary'
                : 'text-error'}
            role="img"
            aria-label={pin.label}
            data-testid="places-pin-{pin.kind}"
            data-x={pin.sx.toFixed(1)}
            data-y={pin.sy.toFixed(1)}
          >
            <circle
              cx={pin.sx}
              cy={pin.sy}
              r={pin.kind === 'place' ? 5 : 7}
              fill="currentColor"
              stroke="white"
              stroke-width="2"
            />
            {#if pin.kind !== 'self'}
              <text
                x={pin.sx + 10}
                y={pin.sy + 4}
                font-size="11"
                font-weight="700"
                fill="currentColor"
                stroke="white"
                stroke-width="3"
                paint-order="stroke">{pin.label}</text
              >
            {/if}
          </g>
        {/each}
      </svg>
    {/if}
  </div>
  <div class="pointer-events-none absolute top-2 right-2 left-2 flex items-start gap-2">
    <div class="pointer-events-auto">
      {@render actions?.()}
    </div>
    <div class="pointer-events-auto ml-auto flex flex-col gap-1">
      <button
        type="button"
        class="bg-surface-container text-on-surface rounded-full p-2 font-bold"
        onclick={() => zoomBy(1.5)}
        aria-label={$t('places.zoomIn')}>+</button
      >
      <button
        type="button"
        class="bg-surface-container text-on-surface rounded-full p-2 font-bold"
        onclick={() => zoomBy(1 / 1.5)}
        aria-label={$t('places.zoomOut')}>−</button
      >
      <button
        type="button"
        class="bg-surface-container text-primary rounded-full p-2"
        onclick={recentre}
        aria-label={$t('places.recentre')}
      >
        <LocationIcon class="size-icon-sm" />
      </button>
    </div>
  </div>
</div>
