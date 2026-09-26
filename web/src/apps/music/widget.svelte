<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts" module>
  import { registerMessages } from '@mica/sdk';
  import en from './locales/en.json';
  import de from './locales/de.json';

  /**
   * Once per module, never per mount. `registerMessages` bumps the catalog revision, which
   * re-derives `t` and with it the shell's widget list, which hands `WidgetHost` a new entry
   * and re-runs its load: a registration inside the component re-triggered itself forever,
   * and the widget never got to paint.
   */
  registerMessages('music', { en, de });
</script>

<script lang="ts">
  import {
    PauseIcon,
    PlayIcon,
    SkipNextIcon,
    useLocale,
    useMusic,
    useNavigation,
    type WidgetSize
  } from '@mica/sdk';

  /**
   * Music's home-screen widget (MICA-245): what is playing, and pause/play and next.
   *
   * A controller over the same `useMusic()` stores the app and the shade's card read, so
   * it owns no playback state and cannot disagree with either. The catalog is registered
   * in the module script above, because a widget is loaded on its own, ahead of the app
   * ever being opened; registering the same namespace twice merges rather than replaces.
   *
   * **No artist line.** The player reports a title and nothing else; YouTube gives the
   * phone no artist, and inventing one from the title would be wrong as often as right.
   * The title falls back to the id, exactly as the card does.
   *
   * Nothing animates, and the card is a themed `surface-container`, so text is always a
   * measured token pair rather than text over a photograph.
   */
  let { size }: { size: WidgetSize } = $props();

  const { t } = useLocale();
  const { openApp } = useNavigation();
  const {
    musicSource,
    musicStatus,
    musicNowPlaying,
    musicHasNext,
    thumbnailUrlFor,
    pauseMusic,
    resumeMusic,
    nextTrack
  } = useMusic();

  const title = $derived($musicNowPlaying?.title ?? $musicSource?.videoId ?? $t('music.title'));
  const art = $derived(thumbnailUrlFor($musicNowPlaying?.videoId ?? $musicSource?.videoId ?? null));
  const playing = $derived($musicStatus === 'playing' || $musicStatus === 'loading');
  const open = () => openApp('music');
  const toggle = () => (playing ? pauseMusic() : resumeMusic());
</script>

{#if $musicSource}
  <div
    data-testid="widget-music"
    data-size={size}
    role="group"
    aria-label={$t('music.widgetLabel')}
    class="bg-surface-container text-on-surface flex h-full w-full overflow-hidden rounded-box p-3 {size ===
    '2x2'
      ? 'flex-col gap-3'
      : 'flex-row items-center gap-3'}"
  >
    <button
      type="button"
      class="flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-left {size === '2x2'
        ? 'flex-col items-start'
        : ''}"
      aria-label={$t('music.widgetOpen', { title })}
      onclick={open}
    >
      {#if art}
        {#if size === '2x2'}
          <img src={art} alt="" class="h-20 w-20 shrink-0 rounded-chip object-cover" />
        {:else}
          <img src={art} alt="" class="h-12 w-12 shrink-0 rounded-chip object-cover" />
        {/if}
      {/if}
      <span
        class="text-title-medium min-w-0 {size === '2x2' ? 'line-clamp-2' : 'truncate'}"
        data-testid="widget-music-title">{title}</span
      >
    </button>
    <div class="flex shrink-0 items-center gap-2">
      <button
        type="button"
        class="bg-primary text-on-primary flex h-10 w-10 cursor-pointer items-center justify-center rounded-full"
        aria-label={playing ? $t('music.widgetPause') : $t('music.widgetPlay')}
        data-testid="widget-music-toggle"
        onclick={toggle}
      >
        {#if playing}<PauseIcon class="h-5 w-5" />{:else}<PlayIcon class="h-5 w-5" />{/if}
      </button>
      {#if $musicHasNext}
        <button
          type="button"
          class="flex h-10 w-10 cursor-pointer items-center justify-center rounded-full"
          aria-label={$t('music.widgetNext')}
          data-testid="widget-music-next"
          onclick={nextTrack}
        >
          <SkipNextIcon class="h-5 w-5" />
        </button>
      {/if}
    </div>
  </div>
{:else}
  <button
    type="button"
    data-testid="widget-music-empty"
    aria-label={$t('music.widgetOpenEmpty')}
    data-size={size}
    class="bg-surface-container text-on-surface-variant text-body-medium flex h-full w-full cursor-pointer flex-col items-center justify-center gap-1 overflow-hidden rounded-box p-3 text-center"
    onclick={open}
  >
    <span class="text-title-medium text-on-surface">{$t('music.widgetEmptyTitle')}</span>
    {#if size === '2x2'}<span>{$t('music.widgetEmptyHint')}</span>{/if}
  </button>
{/if}
