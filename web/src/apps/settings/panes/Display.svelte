<script lang="ts">
  import { ToggleSwitch, useClock, useDisplay } from '@gphone/sdk';
  import ThemeAndWallpaper from '../components/ThemeAndWallpaper.svelte';

  // Appearance lives on this page rather than behind a row on it. It was briefly its own
  // pane, which put the thing a player most often changes two taps deep for no gain — the
  // sections are groups on one scrollable page, in the order you would set them: light or
  // dark first, since it reframes everything after it, then the color, the presets, a
  // photo, and finally the size and the clock.
  const { is24Hour } = useClock();
  const {
    displaySize,
    setDisplaySize,
    displaySizeDefault,
    phoneBox,
    isSizeLimited,
    homeGridColumns,
    homeGridRows,
    homeGridColumnsMin,
    homeGridColumnsMax,
    homeGridRowsMin,
    homeGridRowsMax,
    setHomeGridSize
  } = useDisplay();

  const rendered = $derived(
    `${Math.round($phoneBox.width)} × ${Math.round($phoneBox.height)} pixels`
  );
</script>

<div class="space-y-6 p-4">
  <ThemeAndWallpaper />

  <div>
    <h2 class="text-on-surface-variant text-body-medium mb-2 px-2 tracking-wider uppercase">
      Size
    </h2>
    <div class="bg-surface-container overflow-hidden rounded-xl">
      <div class="flex flex-col gap-3 p-4">
        <div class="text-body-medium flex items-center justify-between">
          <span class="text-on-surface font-medium">Phone Size</span>
          <span class="text-on-surface font-mono">{$displaySize}%</span>
        </div>
        <input
          type="range"
          min="0"
          max="100"
          step="1"
          value={$displaySize}
          aria-label="Phone size"
          oninput={(e) => setDisplaySize(Number((e.currentTarget as HTMLInputElement).value))}
          class="bg-surface h-1.5 w-full cursor-pointer appearance-none rounded-lg accent-blue-500"
        />
        <div class="text-on-surface-variant text-body-small flex items-center justify-between">
          <span>Smaller</span>
          <span class="font-mono">{rendered}</span>
          <span>Larger</span>
        </div>
        <!-- Why the largest setting is smaller here than it would be on a bigger window.
             The slider itself is never dead now — it spans whatever this window can draw,
             so every position moves the phone — but the top of that range is the window's
             to decide, and saying so beats leaving it a mystery. -->
        {#if $isSizeLimited}
          <p class="text-on-surface-variant text-body-small">
            This window sets how large the phone can go. Make it taller for more range.
          </p>
        {/if}
      </div>
      <div class="border-outline-variant border-t p-4">
        <button
          type="button"
          onclick={() => setDisplaySize(displaySizeDefault)}
          disabled={$displaySize === displaySizeDefault}
          class="border-outline-variant bg-surface text-on-surface hover:bg-surface-container-high disabled:hover:bg-surface duration-short ease-standard text-body-small w-full cursor-pointer rounded-lg border py-2 transition-colors disabled:cursor-default disabled:opacity-40"
        >
          Reset to Default
        </button>
      </div>
    </div>
    <p class="text-on-surface-variant text-body-small mt-2 px-2">
      The phone always keeps its shape; this changes how large it is drawn on screen.
    </p>
  </div>

  <div>
    <h2 class="text-on-surface-variant text-body-medium mb-2 px-2 tracking-wider uppercase">
      Home Screen Grid
    </h2>
    <div class="bg-surface-container overflow-hidden rounded-xl p-4">
      <div class="flex flex-col gap-3">
        <div class="text-body-medium flex items-center justify-between">
          <span class="text-on-surface font-medium">Columns</span>
          <div class="flex items-center gap-3">
            <button
              type="button"
              aria-label="Fewer columns"
              disabled={$homeGridColumns <= homeGridColumnsMin}
              onclick={() => setHomeGridSize($homeGridColumns - 1, $homeGridRows)}
              class="bg-surface text-on-surface hover:bg-surface-container-high text-body-medium h-7 w-7 cursor-pointer rounded-full disabled:cursor-default disabled:opacity-40"
              >−</button
            >
            <span class="text-on-surface w-4 text-center font-mono">{$homeGridColumns}</span>
            <button
              type="button"
              aria-label="More columns"
              disabled={$homeGridColumns >= homeGridColumnsMax}
              onclick={() => setHomeGridSize($homeGridColumns + 1, $homeGridRows)}
              class="bg-surface text-on-surface hover:bg-surface-container-high text-body-medium h-7 w-7 cursor-pointer rounded-full disabled:cursor-default disabled:opacity-40"
              >+</button
            >
          </div>
        </div>
        <div class="text-body-medium flex items-center justify-between">
          <span class="text-on-surface font-medium">Rows</span>
          <div class="flex items-center gap-3">
            <button
              type="button"
              aria-label="Fewer rows"
              disabled={$homeGridRows <= homeGridRowsMin}
              onclick={() => setHomeGridSize($homeGridColumns, $homeGridRows - 1)}
              class="bg-surface text-on-surface hover:bg-surface-container-high text-body-medium h-7 w-7 cursor-pointer rounded-full disabled:cursor-default disabled:opacity-40"
              >−</button
            >
            <span class="text-on-surface w-4 text-center font-mono">{$homeGridRows}</span>
            <button
              type="button"
              aria-label="More rows"
              disabled={$homeGridRows >= homeGridRowsMax}
              onclick={() => setHomeGridSize($homeGridColumns, $homeGridRows + 1)}
              class="bg-surface text-on-surface hover:bg-surface-container-high text-body-medium h-7 w-7 cursor-pointer rounded-full disabled:cursor-default disabled:opacity-40"
              >+</button
            >
          </div>
        </div>
      </div>
    </div>
    <p class="text-on-surface-variant text-body-small mt-2 px-2">
      Shrinking the grid moves anything it no longer fits to the next open space, rather than hiding
      it.
    </p>
  </div>

  <div>
    <h2 class="text-on-surface-variant text-body-medium mb-2 px-2 tracking-wider uppercase">
      Clock
    </h2>
    <div class="bg-surface-container overflow-hidden rounded-xl">
      <ToggleSwitch
        label="24-Hour Time"
        description="Use 24-hour format"
        checked={$is24Hour}
        onchange={(v) => is24Hour.set(v)}
      />
    </div>
  </div>
</div>
