<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import {
    useWallpaper,
    useWallpaperWrite,
    useTheme,
    useThemeWrite,
    useMedia,
    useClock,
    useDisplay,
    EmptyState,
    MediaThumb,
    SegmentedControl,
    usePhoneNotification
  } from '@gphone/sdk';
  import ColorWheelPicker from './ColorWheelPicker.svelte';

  const {
    wallpaperStore,
    wallpaperBackground,
    activeSeed,
    backgroundForSeed,
    seedFromImage,
    presets
  } = useWallpaper();
  const { setWallpaperSeed, setPresetWallpaper, setWallpaperImage, resetWallpaper } =
    useWallpaperWrite();
  const { themeStore, schemeStore, seedFromRgbString } = useTheme();
  const { setThemeMode } = useThemeWrite();
  const { media, fullMedia } = useMedia();
  const { toast } = usePhoneNotification();
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

  /**
   * Photos a wallpaper can be made from.
   *
   * `kind === 'photo'` because that is what the heading above promises and what
   * `seedFromImage` can read; a voice note or a shared location is in the same table and is
   * not a wallpaper. `thumbnail` because that is what the grid below draws — the list read
   * no longer carries `data` (MICA-110), so keying the filter off bytes selected nothing
   * at all and reported an empty gallery to a player with a full one.
   */
  const wallpaperPhotos = $derived(
    $media.filter((photo) => photo.kind === 'photo' && photo.thumbnail).slice(0, 6)
  );

  /**
   * A wallpaper wants the original, so it is fetched when one is picked.
   *
   * The tile is drawn from the thumbnail and the wallpaper is not: this fills the whole
   * phone and the scheme is generated from its pixels, so a 320px still would be both
   * visibly soft and a worse seed. `media.full` is the one call that answers with `data`,
   * and it is made here — once, for the photo actually chosen — rather than for all six.
   */
  const applyPhoto = async (mediaId: number) => {
    try {
      const full = await fullMedia(mediaId);
      if (!full?.data) throw new Error('That photo has no image data.');

      const derivedSeed = await seedFromImage(full.data);
      setWallpaperImage(`url('${full.data}')`, derivedSeed ?? undefined);
    } catch (e) {
      console.warn(`Photo ${mediaId} could not be applied as a wallpaper.`, e);
      toast.show({
        type: 'error',
        app: 'settings',
        message: 'That photo could not be loaded. Try another.'
      });
    }
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
    <h2 class="text-on-surface-variant text-body-medium mb-2 px-2 tracking-wider uppercase">
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
        <div class="text-on-surface text-label-small flex items-center justify-between px-2 pt-1.5">
          <span class:text-on-wallpaper={wallpaper.type === 'image'}>{$formattedTime}</span>
          <span
            class="border-on-surface h-1.5 w-3 rounded-xs border"
            class:text-on-wallpaper={wallpaper.type === 'image'}
          ></span>
        </div>

        <div class="grid flex-1 grid-cols-3 content-start gap-x-2 gap-y-1.5 px-2 pt-3">
          {#each DEMO_TILES as tile (tile)}
            <div class="flex flex-col items-center gap-0.5">
              <div class="size-icon-lg rounded-sm {tile}"></div>
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

      <span class="text-on-surface-variant text-label-small font-mono">{rendered}</span>

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
    <h2 class="text-on-surface-variant text-body-medium mb-2 px-2 tracking-wider uppercase">
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
            <span class="text-on-surface-variant text-label-small">{swatch.label}</span>
          </div>
        {/each}
      </div>
      <div class="flex items-center gap-3">
        <span class="text-on-surface-variant text-label-small font-mono">{seed}</span>
        <button
          type="button"
          onclick={() => resetWallpaper()}
          class="text-primary text-body-small cursor-pointer hover:underline"
        >
          Reset
        </button>
      </div>
    </div>
    <div class="bg-surface-container rounded-xl p-4">
      <ColorWheelPicker color={seed} onchange={applyCustomColor} />
      <p class="text-on-surface-variant text-label-small mt-3 text-center">
        The wallpaper and every color in the phone are generated from this one.
      </p>
    </div>
  </div>

  <!-- Presets: named colors, nothing more. The swatch is the wallpaper they produce. -->
  <div>
    <h2 class="text-on-surface-variant text-body-medium mb-2 px-2 tracking-wider uppercase">
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
          <span class="text-on-surface text-body-small mt-2">{preset.label}</span>
        </button>
      {/each}
    </div>
  </div>

  <!-- Photos -->
  <div>
    <h2 class="text-on-surface-variant text-body-medium mb-2 px-2 tracking-wider uppercase">
      From a Photo
    </h2>
    <div class="bg-surface-container rounded-xl p-4 text-center">
      {#if wallpaperPhotos.length === 0}
        <EmptyState
          title="No photos in Gallery"
          description="Photos taken with the Camera app can be used as a wallpaper, and the phone takes its colors from them."
        />
      {:else}
        <div class="grid grid-cols-3 gap-2">
          {#each wallpaperPhotos as photo (photo.id)}
            <button
              type="button"
              onclick={() => applyPhoto(photo.id)}
              class="border-outline-variant hover:border-primary relative aspect-square cursor-pointer overflow-hidden rounded-lg border"
            >
              <!-- `MediaThumb` rather than a bare `<img src={photo.data}>`: the tile is a
                   thumbnail now, and this is the one place that knows how to draw a media
                   row — including refusing a source whose scheme could execute. -->
              <MediaThumb item={photo} alt="Use as wallpaper" />
            </button>
          {/each}
        </div>
      {/if}
    </div>
  </div>
</div>
