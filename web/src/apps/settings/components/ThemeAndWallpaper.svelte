<script lang="ts">
  import {
    useWallpaper,
    useTheme,
    useMedia,
    useClock,
    useDisplay,
    EmptyState,
    SegmentedControl
  } from '@gphone/sdk';
  import ColorWheelPicker from './ColorWheelPicker.svelte';

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
  const { themeStore, setThemeMode, schemeStore, seedFromRgbString } = useTheme();
  const { media } = useMedia();
  const { formattedTime } = useClock();
  const { phoneBox } = useDisplay();

  const wallpaper = $derived($wallpaperStore);
  const seed = $derived($activeSeed);
  const scheme = $derived($schemeStore);
  const mode = $derived($themeStore.mode);

  /**
   * The two schemes, rendered rather than described.
   *
   * A toggle labelled "Light Theme" tells you the name of a thing you cannot see until you
   * commit to it. These tiles are the same shape as the preset buttons below and show the
   * actual generated colors — wallpaper, a card, text, the accent — so the choice is made
   * by looking rather than by reading.
   *
   * Every value here is inline rather than a utility class, and that is forced: a class
   * resolves against the *active* theme, so both tiles would render identically in
   * whichever scheme is currently on.
   */
  /**
   * What a tile paints behind its mock elements.
   *
   * A photo is the same picture in either scheme, so both tiles show it and only the
   * chrome on top differs — which is exactly the comparison being made. Only a generated
   * background changes with the mode.
   */
  const MODE_OPTIONS = [
    { id: 'light', label: 'Light' },
    { id: 'dark', label: 'Dark' }
  ];

  /** Six tiles, in roles rather than invented colors, so the preview shows the palette. */
  const DEMO_TILES = [
    'bg-primary-container',
    'bg-secondary-container',
    'bg-tertiary-container',
    'bg-error',
    'bg-surface-container-highest',
    'bg-primary'
  ];

  const rendered = $derived(`${Math.round($phoneBox.width)} × ${Math.round($phoneBox.height)}`);
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

<div class="space-y-6">
  <!-- Appearance -->
  <div>
    <h2 class="text-on-surface-variant mb-2 px-2 text-sm font-medium tracking-wider uppercase">
      Appearance
    </h2>
    <div class="bg-surface-container flex flex-col items-center gap-3 rounded-xl p-4">
      <!-- Everything on this page shows up here: the scheme, the seed, the wallpaper, the
           clock format, and the rendered size beneath. Utility classes rather than inline
           values, deliberately — the preview renders the *active* theme, so a class is
           both simpler and guaranteed to match what the phone will actually do. Only the
           wallpaper is inline, because it is generated rather than a token. -->
      <div
        class="border-outline shadow-elevation-3 relative flex w-[132px] flex-col overflow-hidden rounded-lg border-2"
        style={`aspect-ratio: 400 / 850; background: ${background};`}
      >
        <div class="text-on-surface flex items-center justify-between px-2 pt-1.5 text-[7px]">
          <span class:text-on-wallpaper={wallpaper.type === 'image'}>{$formattedTime}</span>
          <span
            class="border-on-surface h-1.5 w-3 rounded-[2px] border"
            class:text-on-wallpaper={wallpaper.type === 'image'}
          ></span>
        </div>

        <div class="grid flex-1 grid-cols-3 content-start gap-x-2 gap-y-1.5 px-2 pt-3">
          {#each DEMO_TILES as tile (tile)}
            <div class="flex flex-col items-center gap-0.5">
              <div class="h-6 w-6 rounded-[7px] {tile}"></div>
              <span
                class="text-on-surface h-0.5 w-4 rounded-full bg-current opacity-70"
                class:text-on-wallpaper={wallpaper.type === 'image'}
              ></span>
            </div>
          {/each}
        </div>

        <div class="bg-surface-container-high mx-2 mb-2 rounded-md px-1.5 py-1">
          <div class="bg-on-surface h-0.5 w-2/3 rounded-full opacity-80"></div>
          <div class="bg-on-surface-variant mt-1 h-0.5 w-1/2 rounded-full opacity-60"></div>
        </div>

        <div class="bg-on-surface mx-auto mb-1.5 h-[2px] w-8 rounded-full opacity-60"></div>
      </div>

      <span class="text-on-surface-variant font-mono text-[10px]">{rendered}</span>

      <SegmentedControl
        options={MODE_OPTIONS}
        selected={mode}
        onchange={(id) => setThemeMode(id as 'light' | 'dark')}
        aria-label="Theme mode"
      />
    </div>
  </div>

  <!-- Color -->
  <div>
    <h2 class="text-on-surface-variant mb-2 px-2 text-sm font-medium tracking-wider uppercase">
      Color
    </h2>
    <div class="bg-surface-container mb-3 flex flex-col items-center gap-3 rounded-xl p-4">
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
    <div class="bg-surface-container rounded-xl p-4">
      <ColorWheelPicker color={seed} onchange={applyCustomColor} />
      <p class="text-on-surface-variant mt-3 text-center text-[11px] leading-relaxed">
        The wallpaper and every color in the phone are generated from this one.
      </p>
    </div>
  </div>

  <!-- Presets: named colors, nothing more. The swatch is the wallpaper they produce. -->
  <div>
    <h2 class="text-on-surface-variant mb-2 px-2 text-sm font-medium tracking-wider uppercase">
      Presets
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
            style={`background: ${backgroundForSeed(preset.seed, mode)};`}
          ></div>
          <span class="text-on-surface mt-2 text-xs font-medium">{preset.label}</span>
        </button>
      {/each}
    </div>
  </div>

  <!-- Photos -->
  <div>
    <h2 class="text-on-surface-variant mb-2 px-2 text-sm font-medium tracking-wider uppercase">
      From a Photo
    </h2>
    <div class="bg-surface-container rounded-xl p-4 text-center">
      {#if $media.length === 0}
        <EmptyState
          title="No photos in Gallery"
          description="Photos taken with the Camera app can be used as a wallpaper, and the phone takes its colors from them."
        />
      {:else}
        <div class="grid grid-cols-3 gap-2">
          <!-- `data` is optional now: a hotlinked or link-preview row has a url and no
               bytes. Nothing writes one yet, but a wallpaper needs actual bytes, so the
               ones without are skipped rather than rendered as a broken tile. -->
          {#each $media.filter((p) => p.data).slice(0, 6) as photo (photo.id)}
            <button
              type="button"
              onclick={() => applyPhoto(photo.data!)}
              class="border-outline-variant hover:border-primary relative aspect-square cursor-pointer overflow-hidden rounded-lg border"
            >
              <img src={photo.data} alt="Use as wallpaper" class="h-full w-full object-cover" />
            </button>
          {/each}
        </div>
      {/if}
    </div>
  </div>
</div>
