<script lang="ts">
  import { useWallpaper, useTheme, usePhotos, EmptyState } from '@gphone/sdk';
  import ColorWheelPicker from '../components/ColorWheelPicker.svelte';

  const {
    wallpaperStore,
    setWallpaper,
    setPresetWallpaper,
    resetWallpaper,
    seedFromImage,
    presets
  } = useWallpaper();
  const { themeStore, schemeStore, setThemeSeed, seedFromRgbString } = useTheme();
  const { photos } = usePhotos();

  const activeWallpaper = $derived($wallpaperStore);
  const seed = $derived($themeStore.seed);
  const scheme = $derived($schemeStore);

  let pickerColor = $state('rgba(21, 93, 252, 1)');

  /**
   * The picker sets the background *and* the colour everything is generated from.
   *
   * These used to be unrelated: the wallpaper was whatever you picked and the UI stayed
   * blue, because the only thing reading the wallpaper was a chain of `value.includes(...)`
   * checks that recognised four strings. Now the seed is the picked colour and every role
   * follows it, so there is nothing left to recognise.
   */
  const applyCustomColor = (color: string) => {
    pickerColor = color;
    const derived = seedFromRgbString(color);
    setWallpaper({ type: 'color', value: color }, derived ?? undefined);
  };

  /**
   * A photo seeds the theme from its own dominant colour.
   *
   * `seedFromImage` returns `null` when it cannot read one — a source that is not a
   * `data:` URL would taint the canvas, and a photo that will not decode is not worth
   * hanging the screen over. `null` means keep the seed we already have, so the
   * wallpaper still changes and the theme simply does not.
   */
  const applyPhoto = async (image: string) => {
    setWallpaper({ type: 'image', value: `url('${image}') center/cover no-repeat` });
    const derived = await seedFromImage(image);
    if (derived) setThemeSeed(derived);
  };

  /** The roles worth showing back to the player, in the order they read as a palette. */
  const SWATCHES = [
    { role: 'primary', label: 'Primary' },
    { role: 'secondary', label: 'Secondary' },
    { role: 'tertiary', label: 'Tertiary' },
    { role: 'surface-container-high', label: 'Surface' },
    { role: 'error', label: 'Error' }
  ];
</script>

<div class="space-y-6 p-4">
  <!-- Preview -->
  <div>
    <h2 class="text-on-surface-variant mb-2 px-2 text-sm font-medium tracking-wider uppercase">
      Current
    </h2>
    <div class="bg-surface-container flex flex-col items-center gap-3 rounded-xl p-4">
      <div
        class={`border-outline relative flex h-36 w-20 flex-col items-center justify-between rounded-lg border-2 shadow-lg ${
          activeWallpaper.type === 'preset' ? activeWallpaper.value : ''
        }`}
        style={activeWallpaper.type !== 'preset'
          ? `background: ${activeWallpaper.value};`
          : undefined}
      >
        <div class="text-on-surface mt-2 text-[8px] font-bold">gPhone</div>
        <div class="bg-on-surface mb-2 h-1 w-6 rounded-full"></div>
      </div>

      <!-- The generated scheme, read straight off the store. This is the one screen where
           showing a colour as a value rather than applying it as a class is the point. -->
      <div class="flex items-center gap-1.5">
        {#each SWATCHES as swatch (swatch.role)}
          <div class="flex flex-col items-center gap-1">
            <div
              class="border-outline-variant h-7 w-7 rounded-full border"
              style={`background: ${scheme[swatch.role]};`}
              title={swatch.label}
            ></div>
            <span class="text-on-surface-variant text-[9px]">{swatch.label}</span>
          </div>
        {/each}
      </div>

      <div class="flex items-center gap-3">
        <span class="text-on-surface-variant font-mono text-[10px]">Seed {seed}</span>
        <button
          type="button"
          onclick={() => resetWallpaper()}
          class="text-primary cursor-pointer text-xs hover:underline"
        >
          Reset
        </button>
      </div>
    </div>
  </div>

  <!-- Presets -->
  <div>
    <h2 class="text-on-surface-variant mb-2 px-2 text-sm font-medium tracking-wider uppercase">
      Presets
    </h2>
    <div class="grid grid-cols-2 gap-3">
      {#each presets as preset (preset.id)}
        <button
          type="button"
          onclick={() => setPresetWallpaper(preset)}
          class={`flex cursor-pointer flex-col overflow-hidden rounded-xl border p-2 text-left transition-all ${
            activeWallpaper.value === preset.value
              ? 'border-primary ring-primary ring-2'
              : 'border-outline-variant bg-surface-container hover:border-outline'
          }`}
        >
          <div
            class={`h-12 w-full rounded-lg ${preset.value.startsWith('bg-') ? preset.value : ''}`}
            style={!preset.value.startsWith('bg-') ? `background: ${preset.value};` : undefined}
          ></div>
          <span class="text-on-surface mt-2 text-xs font-medium">{preset.label}</span>
        </button>
      {/each}
    </div>
  </div>

  <!-- Custom colour -->
  <div>
    <h2 class="text-on-surface-variant mb-2 px-2 text-sm font-medium tracking-wider uppercase">
      Custom Colour
    </h2>
    <div class="bg-surface-container rounded-xl p-4">
      <ColorWheelPicker color={pickerColor} onchange={applyCustomColor} />
      <p class="text-on-surface-variant mt-3 text-center text-[11px] leading-relaxed">
        The whole phone is generated from this colour. Material 3 interprets it rather than copying
        it, so a very saturated pick comes back calmer than you chose.
      </p>
    </div>
  </div>

  <!-- Photos -->
  <div>
    <h2 class="text-on-surface-variant mb-2 px-2 text-sm font-medium tracking-wider uppercase">
      From a Photo
    </h2>
    <div class="bg-surface-container rounded-xl p-4 text-center">
      {#if $photos.length === 0}
        <EmptyState
          title="No photos in Gallery"
          description="Photos taken with the Camera app can be used as a wallpaper, and the phone takes its colours from them."
        />
      {:else}
        <div class="grid grid-cols-3 gap-2">
          {#each $photos.slice(0, 6) as photo (photo.id)}
            <button
              type="button"
              onclick={() => applyPhoto(photo.image)}
              class="border-outline-variant hover:border-primary relative aspect-square cursor-pointer overflow-hidden rounded-lg border"
            >
              <img src={photo.image} alt="Use as wallpaper" class="h-full w-full object-cover" />
            </button>
          {/each}
        </div>
      {/if}
    </div>
  </div>
</div>
