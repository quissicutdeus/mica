<script lang="ts">
  import {
    Button,
    EmptyState,
    PauseIcon,
    PlayIcon,
    Screen,
    StopIcon,
    useAppLevels,
    useMusic,
    type AppProps
  } from '@gphone/sdk';

  /**
   * MICA-111 phase 1 — a controller, and nothing more.
   *
   * The player lives in the shell (`shell/MusicPlayer.svelte`), outside everything the
   * phone's close tears down, so this component can be destroyed and rebuilt with a track
   * still running. That is the reason it holds no playback state of its own: everything
   * below reads `useMusic()`'s stores, and closing the app is not an event playback has to
   * hear about.
   *
   * **Local playback only.** Nobody else can hear this yet — the proximity fan-out is
   * phase 2 — and the screen says so rather than letting a person find out by asking a
   * friend whether they heard anything.
   */

  let { onback }: AppProps = $props();

  const {
    musicSource,
    musicStatus,
    musicVolume,
    canPlay,
    playSource,
    pauseMusic,
    resumeMusic,
    stopMusic,
    setMusicVolume
  } = useMusic();

  // No internal levels — the paste field, the transport and the volume are one screen —
  // but the call is still what claims the physical Back key for this app. Without it the
  // shell's own handler is the only claimant, which is the same behaviour here and would
  // silently stop being so the moment a second level was added.
  const app = useAppLevels({
    appId: 'music',
    title: 'Music',
    onback: () => onback(),
    levels: []
  });

  let link = $state('');
  let error = $state('');

  const isPlaying = $derived($musicStatus === 'playing' || $musicStatus === 'loading');

  const statusLabel = $derived(
    $musicStatus === 'loading'
      ? 'Starting…'
      : $musicStatus === 'playing'
        ? 'Playing'
        : $musicStatus === 'paused'
          ? 'Paused'
          : 'Nothing playing'
  );

  /**
   * What the phone will show for the loaded track.
   *
   * The id, deliberately — the phone never fetched a title and phase 1 does not add a
   * network call to get one. Showing the id is honest about what is actually stored
   * (`shared/youtube.ts`), and it is what a person would paste back to reach the same
   * track.
   */
  const loadedLabel = $derived.by(() => {
    const source = $musicSource;
    if (!source) return '';
    if (source.videoId && source.playlistId) return `${source.videoId} · playlist`;
    if (source.videoId) return source.videoId;
    return `Playlist ${source.playlistId ?? ''}`.trim();
  });

  const submit = () => {
    const pasted = link.trim();
    if (!pasted) return;
    // Asked before the call, not inferred from it. `playSource` is fire-and-forget by
    // design — over the add-on seam it is a `postMessage` and could only answer with a
    // promise — so the "is this a link" question is this screen's to answer, in its own
    // words, from the same parser the shell will use.
    if (!canPlay(pasted)) {
      error = "That doesn't look like a YouTube link.";
      return;
    }
    playSource(pasted);
    link = '';
    error = '';
  };

  const toggle = () => {
    if (isPlaying) pauseMusic();
    else resumeMusic();
  };
</script>

<Screen title={app.title} onback={app.back}>
  <div class="min-h-0 flex-1 space-y-6 overflow-y-auto p-4">
    <div class="space-y-2">
      <label class="text-body-medium text-on-surface-variant block" for="music-link">
        YouTube link
      </label>
      <input
        id="music-link"
        type="text"
        bind:value={link}
        onkeydown={(e) => {
          if (e.key === 'Enter') submit();
        }}
        placeholder="Paste a video or playlist link"
        class="bg-surface-container text-on-surface border-outline-variant text-body-medium w-full rounded-lg border p-3"
      />
      {#if error}
        <p class="text-body-small text-error">{error}</p>
      {/if}
      <Button onclick={submit} disabled={!link.trim()} class="w-full">Play</Button>
    </div>

    {#if $musicSource}
      <div class="bg-surface-container-low space-y-4 rounded-lg p-4">
        <div>
          <p class="text-body-small text-on-surface-variant">{statusLabel}</p>
          <p class="text-body-medium text-on-surface font-mono break-all">{loadedLabel}</p>
        </div>

        <div class="flex items-center gap-3">
          <Button
            onclick={toggle}
            variant="icon"
            class="bg-primary-container text-on-primary-container"
            aria-label={isPlaying ? 'Pause' : 'Play'}
          >
            {#if isPlaying}
              <PauseIcon class="h-6 w-6" />
            {:else}
              <PlayIcon class="h-6 w-6" />
            {/if}
          </Button>
          <Button
            onclick={stopMusic}
            variant="icon"
            class="bg-surface-container-high text-on-surface"
            aria-label="Stop"
          >
            <StopIcon class="h-6 w-6" />
          </Button>
        </div>
      </div>
    {:else}
      <EmptyState
        title="Nothing playing"
        description="Paste a YouTube video or playlist link to start."
      />
    {/if}

    <div class="space-y-2">
      <div class="text-body-medium flex items-center justify-between">
        <span class="text-on-surface font-medium">Volume</span>
        <span class="text-on-surface font-mono">{Math.round($musicVolume * 100)}%</span>
      </div>
      <input
        type="range"
        min="0"
        max="100"
        value={Math.round($musicVolume * 100)}
        aria-label="Music volume"
        oninput={(e) => setMusicVolume(Number(e.currentTarget.value) / 100)}
        class="bg-surface h-1.5 w-full cursor-pointer appearance-none rounded-lg accent-blue-500"
      />
    </div>

    <!-- Said on the screen rather than left to be discovered. Phase 1 is local playback,
         and a music app that looks like a boombox but is only ever heard by one person is
         a bug report waiting to be filed. -->
    <p class="text-body-small text-on-surface-variant">
      Only you can hear this. Playing out loud to people nearby is not built yet.
    </p>
  </div>
</Screen>
