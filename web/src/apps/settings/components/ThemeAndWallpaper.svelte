<script lang="ts">
  import { useWallpaper, useTheme, usePhotos, EmptyState } from '@gphone/sdk';
  import ColorWheelPicker from '../components/ColorWheelPicker.svelte';

  const {
    wallpaperStore,
    wallpaperBackground,
    activeSeed,
    backgroundForSeed,
    setWallpaperSeed,
    setPresetWallpaper,
    setWallpaperImage,
    resetWallpaper,
    seedFromImage,
    presets
  } = useWallpaper();
  const { schemeStore, seedFromRgbString } = useTheme();
  const { photos } = usePhotos();

  const wallpaper = $derived($wallpaperStore);
  const seed = $derived($activeSeed);
  const scheme = $derived($schemeStore);
  const background = $derived($wallpaperBackground);

  /**
   * The wheel picks the one color everything is generated from — the wallpaper included.
   * There is nothing else to set, which is the whole point of the presets and the wheel
   * being the same mechanism.
   */
  const applyCustomColor = (color: string) => {
    const picked = seedFromRgbString(color);
    if (picked) setWallpaperSeed(picked);
  };

  const applyPhoto = async (image: string) => {
    const derivedSeed = await seedFromImage(image);
    setWallpaperImage(`url('${image}')`, derivedSeed ?? undefined);
  };

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
        class="border-outline relative flex h-36 w-20 flex-col items-center justify-between rounded-lg border-2 shadow-lg"
        style={`background: ${background};`}
      >
        <div class="text-on-surface mt-2 text-[8px] font-bold">gPhone</div>
        <div class="bg-on-surface mb-2 h-1 w-6 rounded-full"></div>
      </div>

      <!-- The generated scheme, read as values off the store. This is the one screen where
           showing a color rather than applying it as a class is the point. -->
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
        <span class="text-on-surface-variant font-mono text-[10px]">{seed}</span>
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

  <!-- Presets: named colors, nothing more. The swatch is the wallpaper they produce. -->
  <div>
    <h2 class="text-on-surface-variant mb-2 px-2 text-sm font-medium tracking-wider uppercase">
      Colors
    </h2>
    <div class="grid grid-cols-3 gap-3">
      {#each presets as preset (preset.id)}
        <button
          type="button"
          onclick={() => setPresetWallpaper(preset)}
          class={`flex cursor-pointer flex-col overflow-hidden rounded-xl border p-2 text-left transition-all ${
            wallpaper.type === 'color' && seed === preset.seed
              ? 'border-primary ring-primary ring-2'
              : 'border-outline-variant bg-surface-container hover:border-outline'
          }`}
        >
          <div
            class="h-12 w-full rounded-lg"
            style={`background: ${backgroundForSeed(preset.seed)};`}
          ></div>
          <span class="text-on-surface mt-2 text-xs font-medium">{preset.label}</span>
        </button>
      {/each}
    </div>
  </div>

  <!-- Custom color -->
  <div>
    <h2 class="text-on-surface-variant mb-2 px-2 text-sm font-medium tracking-wider uppercase">
      Custom Color
    </h2>
    <div class="bg-surface-container rounded-xl p-4">
      <ColorWheelPicker color={seed} onchange={applyCustomColor} />
      <p class="text-on-surface-variant mt-3 text-center text-[11px] leading-relaxed">
        The wallpaper and every color in the phone are generated from this one.
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
          description="Photos taken with the Camera app can be used as a wallpaper, and the phone takes its colors from them."
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
