<script lang="ts">
  import {
    Button,
    EmptyState,
    PauseIcon,
    PlayIcon,
    RepeatIcon,
    RepeatOneIcon,
    Screen,
    ShuffleIcon,
    SpeakerIcon,
    SpeakerOffIcon,
    SkipNextIcon,
    SkipPreviousIcon,
    StopIcon,
    TrashIcon,
    UsersIcon,
    useAppLevels,
    useMusic,
    formatDuration,
    type AppProps,
    type NearbyBroadcast,
    type QueueEntry
  } from '@gphone/sdk';

  /**
   * MICA-111 phase 3 — a controller over the shell's queue, and nothing more.
   *
   * The player and the queue both live in the shell (`shell/MusicPlayer.svelte`,
   * `shell/state/music.ts`), outside everything the phone's close tears down, so this
   * component can be destroyed and rebuilt with a track still running and a queue still
   * lined up behind it. That is the reason it holds no playback state of its own:
   * everything below reads `useMusic()`'s stores, and closing the app is not an event
   * playback has to hear about.
   *
   * **A title is the player's, not ours.** The phone fetches nothing to name a track — the
   * `postMessage` channel the shell already has open reports one — so every label here
   * falls back to the id it was given. That fallback is not a stopgap: in CEF the channel
   * may never answer, and a row that says `dQw4w9WgXcQ` is still a row a person can
   * recognise and re-paste.
   *
   * **People nearby can hear this** as of phase 2, and the screen says so rather than
   * letting somebody find out by being asked to stop. The other half of that is the Nearby
   * list below the queue: who around you is playing something, which of them this phone is
   * actually rendering, and a mute for each. The *global* mute deliberately does not live
   * only here — it is in the notification shade too (`shell/NearbyMusic.svelte`), because
   * somebody being harassed by another player's music should not have to find an app first.
   */

  let { onback }: AppProps = $props();

  const {
    musicQueue,
    musicIndex,
    musicNowPlaying,
    musicError,
    musicPosition,
    musicStatus,
    musicVolume,
    musicRepeat,
    musicShuffle,
    canPlay,
    thumbnailUrlFor,
    describeMusicError,
    playSource,
    enqueue,
    playQueueIndex,
    removeFromQueue,
    clearQueue,
    nextTrack,
    previousTrack,
    seekMusic,
    cycleRepeat,
    toggleShuffle,
    pauseMusic,
    resumeMusic,
    stopMusic,
    setMusicVolume,
    nearbyBroadcasts,
    audibleBroadcasts,
    maxAudibleBroadcasts,
    mutedBroadcasters,
    muteAllNearby,
    toggleBroadcasterMute,
    setMuteAllNearby
  } = useMusic();

  // No internal levels — the paste field, the transport, the queue and the volume are one
  // screen — but the call is still what claims the physical Back key for this app. Without
  // it the shell's own handler is the only claimant, which is the same behaviour here and
  // would silently stop being so the moment a second level was added.
  const app = useAppLevels({
    appId: 'music',
    title: 'Music',
    onback: () => onback(),
    levels: []
  });

  let link = $state('');
  let error = $state('');

  const isPlaying = $derived($musicStatus === 'playing' || $musicStatus === 'loading');
  const current = $derived($musicIndex >= 0 ? ($musicQueue[$musicIndex] ?? null) : null);

  const failure = $derived($musicError);

  /**
   * The scrubber's own value while a finger is down on it.
   *
   * `null` when nobody is dragging, so the control follows the player. Without it every
   * position report during a drag would yank the handle back out from under the person.
   */
  let scrub = $state<number | null>(null);
  const scrubAt = $derived(scrub ?? $musicPosition.current);

  /**
   * No duration, no scrubber — and that is not the same as a zero-length track.
   *
   * The player reports `0` until it knows, and forever for a live stream. Drawing a slider
   * that cannot move would be worse than drawing none.
   */
  const seekable = $derived($musicPosition.duration > 0 && $musicStatus !== 'error');

  const statusLabel = $derived(
    $musicStatus === 'error'
      ? "Can't play this"
      : $musicStatus === 'loading'
        ? 'Starting…'
        : $musicStatus === 'playing'
          ? 'Playing'
          : $musicStatus === 'paused'
            ? 'Paused'
            : 'Stopped'
  );

  /**
   * What a row is called.
   *
   * The reported title when the player has said one, the id when it has not. The id is not
   * a placeholder for a title that failed to arrive — it is what the phone actually stored
   * (`shared/youtube.ts`), and it is what a person would paste back to reach the track.
   */
  const rowTitle = (entry: QueueEntry): string =>
    entry.title ?? entry.videoId ?? `Playlist ${entry.playlistId ?? ''}`.trim();

  /**
   * The line under the name, and mostly there is not one.
   *
   * **A video id is shown only when it is the only thing identifying the row.** It used to
   * be shown under every title, which read as an eleven-character hex-looking string
   * beneath a perfectly good name, in the queue row and the now-playing card at once —
   * twice on one screen, identifying nothing a person cares about.
   *
   * The case the id exists for is the one where there is no title: a blocked or
   * unavailable video never pushes `videoData.title`, and `rowTitle` already falls back to
   * the id there, so the id is on the row's *first* line and repeating it below would be
   * the same duplication in miniature. Hence: with a title, nothing; without one, nothing
   * either, because the name already is the id.
   *
   * A playlist keeps its line, because `PL…` is genuinely what the row is — the embed
   * advances inside it and no single video names it.
   */
  const rowSub = (entry: QueueEntry): string | null =>
    entry.playlistId ? `Playlist ${entry.playlistId}` : null;

  /**
   * The id, for the one case that still wants it: a row that failed.
   *
   * `null` unless the id is genuinely hidden — a row with no title is already showing it
   * as its name. When a track played long enough to be named and *then* refused, the name
   * is a title and the id has nowhere else to appear, which is exactly when somebody wants
   * it: it is what you paste into a bug report, or back into the field to check the link
   * yourself.
   */
  const hiddenId = (entry: QueueEntry): string | null =>
    entry.title && entry.videoId ? entry.videoId : null;

  const nowTitle = $derived.by(() => {
    if (!current) return '';
    return $musicNowPlaying?.title ?? rowTitle(current);
  });

  /**
   * The second line of the now-playing card, which exists mostly for playlists.
   *
   * A playlist row is one queue entry and many tracks — the embed advances inside it and
   * the phone does not choose what plays next — so saying where in the list it has got to
   * is the difference between a queue a person can follow and one that appears stuck.
   */
  const nowSub = $derived.by(() => {
    // Same rule as `rowSub`, and it has to be the same rule: two surfaces disagreeing
    // about when an id is worth showing is only a smaller version of showing it twice.
    if (!current?.playlistId) return null;
    const info = $musicNowPlaying;
    if (info && info.playlistIndex !== null && info.playlistCount !== null) {
      return `Playlist · ${info.playlistIndex + 1} of ${info.playlistCount}`;
    }
    return `Playlist ${current.playlistId}`;
  });

  const nowArt = $derived(thumbnailUrlFor($musicNowPlaying?.videoId ?? current?.videoId ?? null));

  const repeatLabel = $derived(
    $musicRepeat === 'off'
      ? 'Repeat off'
      : $musicRepeat === 'all'
        ? 'Repeat queue'
        : 'Repeat one track'
  );

  /** Both buttons parse first and report in their own words; see `canPlay` in the SDK. */
  const take = (add: (input: string) => void) => {
    const pasted = link.trim();
    if (!pasted) return;
    if (!canPlay(pasted)) {
      error = "That doesn't look like a YouTube link.";
      return;
    }
    add(pasted);
    link = '';
    error = '';
  };

  const toggle = () => {
    if (isPlaying) pauseMusic();
    else resumeMusic();
  };

  /**
   * Who this phone is actually rendering, as a set of broadcaster tokens.
   *
   * A token, never a `source`: a mute is about the person and has to survive them
   * reconnecting, which is the whole of mute evasion (`shell/state/nearbyMusic.ts`).
   *
   * Everything about a nearby row that is not its identity comes from comparing against
   * this: a broadcaster who is nearby but not in here is either muted or has lost the cap,
   * and those are different sentences to a person standing there wondering why they can
   * only hear two of the three stereos around them.
   */
  const audibleTokens = $derived(new Set($audibleBroadcasts.map((b) => b.token)));
  const mutedTokens = $derived(new Set($mutedBroadcasters));

  const isMuted = (b: NearbyBroadcast) => $muteAllNearby || mutedTokens.has(b.token);

  /**
   * What to call somebody whose name the server did not send.
   *
   * Never the token, and never the server id. The token is opaque and identifies nobody;
   * the server id is a connection slot that two different people can wear across a
   * session. Printing either would be offering an identity the phone does not have.
   * "Someone nearby" is less useful and true.
   */
  const who = (b: NearbyBroadcast) => b.label ?? 'Someone nearby';

  /**
   * The one line under a nearby row, and it has three jobs.
   *
   * Muted is the state that has to win, because it is the one the person chose. Below it,
   * "out of range" and "not playing — closest N only" are genuinely different and both are
   * worth saying: the first is distance and will fix itself when they walk over, the second
   * is the cap (`maxAudibleBroadcasts`) and is a rule rather than a fault.
   */
  const nearbyStatus = (b: NearbyBroadcast): string => {
    if ($muteAllNearby) return 'All nearby music muted';
    if (mutedTokens.has(b.token)) return 'Muted';
    if (audibleTokens.has(b.token)) return 'Playing';
    if ($audibleBroadcasts.length >= maxAudibleBroadcasts) {
      return `Not playing — closest ${maxAudibleBroadcasts} only`;
    }
    return 'Out of range';
  };
</script>

<Screen title={app.title} onback={app.back}>
  <div class="flex min-h-0 flex-1 flex-col">
    <div class="space-y-2 p-4">
      <input
        id="music-link"
        type="text"
        bind:value={link}
        onkeydown={(e) => {
          if (e.key === 'Enter') take(playSource);
        }}
        placeholder="Paste a video or playlist link"
        aria-label="YouTube link"
        class="bg-surface-container text-on-surface border-outline-variant text-body-medium w-full rounded-lg border p-3"
      />
      {#if error}
        <p class="text-body-small text-error">{error}</p>
      {/if}
      <div class="flex gap-2">
        <Button onclick={() => take(playSource)} disabled={!link.trim()} class="flex-1">Play</Button
        >
        <Button
          onclick={() => take(enqueue)}
          disabled={!link.trim()}
          variant="secondary"
          class="flex-1">Queue</Button
        >
      </div>
    </div>

    {#if $musicQueue.length}
      <div class="px-4">
        <div class="bg-surface-container-low rounded-lg p-3">
          <div class="flex items-center gap-3">
            {#if nowArt}
              <!-- A still frame, not a player: a plain image on YouTube's thumbnail host,
                   which the embed beside it was already talking to. A failed load leaves
                   the tile's own background, which is why it has one. -->
              <img
                src={nowArt}
                alt=""
                class="bg-surface-container-high h-10 w-16 shrink-0 rounded-md object-cover"
              />
            {/if}
            <div class="min-w-0 flex-1">
              <p class="text-body-small text-on-surface-variant flex items-center gap-1">
                <span>{statusLabel}</span>
                <!-- The disclosure, beside the status word rather than only in the
                     standing line at the bottom of the screen. That line is below the
                     volume slider and is off-screen the moment the queue is more than a
                     few rows long — which is exactly when somebody has been playing for a
                     while and is least likely to remember that a street can hear them.
                     Shown only while sound is actually coming out: a paused phone is not
                     broadcasting, and saying so then would be crying wolf. -->
                {#if isPlaying}
                  <span
                    class="text-label-small text-on-surface-variant flex shrink-0 items-center gap-1"
                  >
                    <UsersIcon class="size-icon-sm" />
                    Out loud
                  </span>
                {/if}
              </p>
              <p class="text-body-medium text-on-surface truncate">
                {nowTitle || 'Nothing loaded'}
              </p>
              {#if failure}
                <!-- Not truncated: this is the one line on the screen that explains why
                     nothing is happening, and a person who cannot read all of it is back
                     to guessing. -->
                <p class="text-body-small text-error">
                  {describeMusicError(failure.reason)} · skip or remove it
                </p>
                <!-- The id, and only on a failure, and only when the name above is a title
                     rather than the id already. See `hiddenId`: this is the row somebody
                     pastes into a bug report. -->
                {#if current && hiddenId(current)}
                  <p class="text-label-small text-on-surface-variant truncate font-mono">
                    {hiddenId(current)}
                  </p>
                {/if}
              {:else if nowSub}
                <p class="text-label-small text-on-surface-variant truncate">{nowSub}</p>
              {/if}
            </div>
          </div>

          {#if seekable}
            <div class="mt-3">
              <input
                type="range"
                min="0"
                max={$musicPosition.duration}
                value={scrubAt}
                aria-label="Seek"
                aria-valuetext={formatDuration(scrubAt)}
                oninput={(e) => (scrub = Number(e.currentTarget.value))}
                onchange={(e) => {
                  seekMusic(Number(e.currentTarget.value));
                  scrub = null;
                }}
                class="bg-surface h-1 w-full cursor-pointer appearance-none rounded-lg accent-blue-500"
              />
              <div class="text-label-small text-on-surface-variant mt-1 flex justify-between">
                <span>{formatDuration(scrubAt)}</span>
                <span>{formatDuration($musicPosition.duration)}</span>
              </div>
            </div>
          {/if}

          <div class="mt-3 flex items-center justify-between">
            <div class="flex items-center gap-1">
              <Button
                onclick={toggleShuffle}
                variant="icon"
                aria-pressed={$musicShuffle}
                aria-label="Shuffle"
                class={$musicShuffle ? 'text-on-primary-container bg-primary-container' : ''}
              >
                <ShuffleIcon class="h-5 w-5" />
              </Button>
              <Button
                onclick={cycleRepeat}
                variant="icon"
                aria-label={repeatLabel}
                class={$musicRepeat === 'off'
                  ? ''
                  : 'text-on-primary-container bg-primary-container'}
              >
                {#if $musicRepeat === 'one'}
                  <RepeatOneIcon class="h-5 w-5" />
                {:else}
                  <RepeatIcon class="h-5 w-5" />
                {/if}
              </Button>
            </div>

            <div class="flex items-center gap-1">
              <Button onclick={previousTrack} variant="icon" aria-label="Previous">
                <SkipPreviousIcon class="h-6 w-6" />
              </Button>
              <Button
                onclick={toggle}
                variant="icon"
                disabled={$musicStatus === 'error'}
                class="bg-primary-container text-on-primary-container"
                aria-label={isPlaying ? 'Pause' : 'Play'}
              >
                {#if isPlaying}
                  <PauseIcon class="h-6 w-6" />
                {:else}
                  <PlayIcon class="h-6 w-6" />
                {/if}
              </Button>
              <Button onclick={nextTrack} variant="icon" aria-label="Next">
                <SkipNextIcon class="h-6 w-6" />
              </Button>
              <Button onclick={stopMusic} variant="icon" aria-label="Stop">
                <StopIcon class="h-6 w-6" />
              </Button>
            </div>
          </div>
        </div>
      </div>

      <div class="mt-3 flex items-center justify-between px-4">
        <span class="text-label-small text-on-surface-variant">Queue · {$musicQueue.length}</span>
        <button onclick={clearQueue} class="text-label-small text-on-surface-variant rounded-md p-1"
          >Clear</button
        >
      </div>

      <!-- The list is the one box that gives: everything above and below it is fixed
           chrome, so it takes the leftover height and scrolls inside it. -->
      <div class="min-h-0 flex-1 overflow-y-auto px-4 pt-1">
        {#each $musicQueue as entry, i (entry.key)}
          <div class="flex items-center gap-1">
            <button
              onclick={() => playQueueIndex(i)}
              aria-current={i === $musicIndex ? 'true' : undefined}
              class="flex min-w-0 flex-1 items-center gap-3 rounded-lg p-2 text-left {i ===
              $musicIndex
                ? 'bg-surface-container-high'
                : ''}"
            >
              {#if thumbnailUrlFor(entry.videoId)}
                <img
                  src={thumbnailUrlFor(entry.videoId)}
                  alt=""
                  class="bg-surface-container-high h-10 w-16 shrink-0 rounded-md object-cover"
                />
              {:else}
                <!-- A playlist row has no video id to draw, and an `<img>` with an empty
                     `src` is not a blank tile — Chromium resolves it against the document
                     and re-requests the page. An empty box is the honest version. -->
                <span class="bg-surface-container-high h-10 w-16 shrink-0 rounded-md"></span>
              {/if}
              <span class="min-w-0 flex-1">
                <span class="text-body-medium text-on-surface block truncate"
                  >{rowTitle(entry)}</span
                >
                {#if entry.error}
                  <span class="text-label-small text-error block truncate"
                    >{describeMusicError(entry.error.reason)}</span
                  >
                  {#if hiddenId(entry)}
                    <span class="text-label-small text-on-surface-variant block truncate font-mono"
                      >{hiddenId(entry)}</span
                    >
                  {/if}
                {:else if rowSub(entry)}
                  <span class="text-label-small text-on-surface-variant block truncate"
                    >{rowSub(entry)}</span
                  >
                {/if}
              </span>
            </button>
            <Button
              onclick={() => removeFromQueue(entry.key)}
              variant="icon"
              aria-label="Remove {rowTitle(entry)} from the queue"
            >
              <TrashIcon class="h-5 w-5" />
            </Button>
          </div>
        {/each}
      </div>
    {:else}
      <EmptyState
        title="Nothing queued"
        description="Paste a YouTube video or playlist link to start."
      />
    {/if}

    <!-- Nearby, and only when there is somebody to list.

         Below the queue rather than above it because it is not what a person opened Music
         to do: the paste field and the transport are the app, and this is the thing you
         come looking for when somebody else's music is the problem. It is a bounded
         scroller of its own so that a crowded street cannot squeeze the queue off the
         screen — everything above and below it is fixed chrome. -->
    {#if $nearbyBroadcasts.length}
      <div class="mt-3 px-4">
        <div class="flex items-center justify-between">
          <span class="text-label-small text-on-surface-variant flex items-center gap-1">
            <UsersIcon class="size-icon-sm" />
            Nearby · {$nearbyBroadcasts.length}
          </span>
          <!-- The global switch, and the same one the notification shade offers. Two places
               for one setting is deliberate: this is where you find it, and the shade is
               where you reach it when you are not already here. -->
          <Button
            onclick={() => setMuteAllNearby(!$muteAllNearby)}
            variant="icon"
            aria-pressed={$muteAllNearby}
            aria-label={$muteAllNearby ? 'Unmute all nearby music' : 'Mute all nearby music'}
            class={$muteAllNearby ? 'text-on-primary-container bg-primary-container' : ''}
          >
            {#if $muteAllNearby}
              <SpeakerOffIcon class="h-5 w-5" />
            {:else}
              <SpeakerIcon class="h-5 w-5" />
            {/if}
          </Button>
        </div>

        <div class="max-h-32 overflow-y-auto pt-1">
          {#each $nearbyBroadcasts as person (person.token)}
            <div class="flex items-center gap-1">
              <div class="flex min-w-0 flex-1 items-center gap-3 p-2">
                {#if thumbnailUrlFor(person.videoId)}
                  <img
                    src={thumbnailUrlFor(person.videoId)}
                    alt=""
                    class="bg-surface-container-high h-10 w-16 shrink-0 rounded-md object-cover"
                    class:opacity-40={isMuted(person)}
                  />
                {:else}
                  <!-- A playlist has no video id to draw, and an `<img>` with an empty
                       `src` re-requests the page rather than rendering a blank tile. -->
                  <span class="bg-surface-container-high h-10 w-16 shrink-0 rounded-md"></span>
                {/if}
                <span class="min-w-0 flex-1">
                  <span class="text-body-medium text-on-surface block truncate">{who(person)}</span>
                  <!-- No title, ever, and that is not an omission. A title arrives on the
                       `postMessage` channel of the frame playing it, and a stranger's frame
                       is not talking to this phone — so a nearby row is a person and a
                       thumbnail, and claiming to know the song would be inventing one. -->
                  <span
                    class="text-label-small block truncate {isMuted(person)
                      ? 'text-on-surface-variant'
                      : 'text-primary'}">{nearbyStatus(person)}</span
                  >
                </span>
              </div>
              <!-- Disabled under the global mute rather than hidden: the row is already
                   silent, so a per-person toggle here would look like it had done nothing.
                   Leaving it visible keeps the list the same shape either way. -->
              <Button
                onclick={() => toggleBroadcasterMute(person.token)}
                variant="icon"
                disabled={$muteAllNearby}
                aria-pressed={mutedTokens.has(person.token)}
                aria-label={mutedTokens.has(person.token)
                  ? `Unmute ${who(person)}`
                  : `Mute ${who(person)}`}
              >
                {#if mutedTokens.has(person.token)}
                  <SpeakerOffIcon class="h-5 w-5" />
                {:else}
                  <SpeakerIcon class="h-5 w-5" />
                {/if}
              </Button>
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <div class="pb-home-indicator space-y-2 px-4 pt-3">
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
      <!-- Said on the screen rather than left to be discovered, and it is the sentence
           that changed in phase 2. A music app that plays out loud without telling you it
           does is how somebody gets shouted at in a bank they thought they were alone in. -->
      <p class="text-body-small text-on-surface-variant">
        People nearby can hear this while it plays.
      </p>
    </div>
  </div>
</Screen>
