<script lang="ts">
  import {
    ConfirmDialog,
    MediaThumb,
    ReportButton,
    ShareSquareIcon,
    TrashIcon,
    fade,
    useMedia
  } from '@gphone/sdk';
  import type { MediaItem } from '@gphone/shared/types';

  /**
   * One photo, full size.
   *
   * The half of the gallery that still wants the original bytes — and, since MICA-110,
   * the only half that gets them. The grid is drawn from thumbnails; this asks for the row
   * it is showing, by id, once.
   */
  let {
    photo,
    busy,
    showDeleteConfirm,
    onsend,
    onreport,
    ondeleterequest,
    ondeletecancel,
    ondeleteconfirm
  }: {
    photo: MediaItem;
    busy: boolean;
    showDeleteConfirm: boolean;
    onsend: () => void;
    onreport: () => void;
    ondeleterequest: () => void;
    ondeletecancel: () => void;
    ondeleteconfirm: () => void;
  } = $props();

  const { media } = useMedia();

  /**
   * Whether this row's bytes are still on the server.
   *
   * `data` is the local capture's base64 and `url` is a hotlink; a row with either can draw
   * itself at full size already. A row with neither is one the list projection stripped —
   * so it is a photo, and opening it is exactly the moment to pay for it.
   */
  const needsBytes = (item: MediaItem): boolean => !item.data && !item.url;

  let full = $state<MediaItem | null>(null);
  let loading = $state(false);
  let failed = $state(false);

  /**
   * Fetch the original, and keep drawing the thumbnail until it lands.
   *
   * `full ?? photo` below is what makes the wait invisible: the grid already handed over a
   * row that can draw itself, so the full view opens instantly at thumbnail resolution and
   * sharpens, rather than opening black. A photo the caller already has in full — a fresh
   * capture, an attachment opened from Messages, a row the grid has already hydrated — skips
   * the round trip entirely.
   *
   * The effect re-runs when `photo` changes and cancels what it had in flight, or a slow
   * reply for the previous photo would arrive and replace the one now on screen.
   */
  $effect(() => {
    const target = photo;

    if (!needsBytes(target)) {
      full = target;
      loading = false;
      failed = false;
      return;
    }

    let cancelled = false;
    full = null;
    loading = true;
    failed = false;

    media
      .full(target.id)
      .then((row) => {
        if (!cancelled && row) full = row;
      })
      .catch((e) => {
        console.warn(`Photo ${target.id} could not be loaded at full size.`, e);
        if (!cancelled) failed = true;
      })
      .finally(() => {
        if (!cancelled) loading = false;
      });

    return () => {
      cancelled = true;
    };
  });
</script>

<div class="relative flex flex-1 flex-col bg-black" transition:fade>
  <div class="flex flex-1 items-center justify-center p-2">
    <!-- `prefer="original"` is load-bearing: without it `MediaThumb` reaches for the
         thumbnail first and draws the grid's small still upscaled, so the fetch above pays
         a round trip whose bytes are then thrown away. -->
    <MediaThumb item={full ?? photo} fit="contain" prefer="original" alt="Photo {photo.id}" />
  </div>

  {#if loading}
    <!-- `aria-live` rather than a spinner: there is already a picture on screen, so the
         thing worth announcing is that a sharper one is on its way. -->
    <p
      class="text-label-small pointer-events-none absolute top-2 left-1/2 -translate-x-1/2 rounded-full bg-media-overlay px-3 py-1 text-white"
      aria-live="polite"
    >
      Loading full size…
    </p>
  {:else if failed}
    <p
      class="text-label-small pointer-events-none absolute top-2 left-1/2 -translate-x-1/2 rounded-full bg-media-overlay px-3 py-1 text-white"
      role="status"
    >
      Showing a preview — the full-size photo could not be loaded.
    </p>
  {/if}

  <div
    class="border-outline-variant flex justify-between border-t bg-black/80 p-4 pb-8 backdrop-blur"
  >
    <button
      class="text-primary hover:text-primary duration-short ease-standard p-2 transition-colors"
      aria-label="Send to nearby devices"
      disabled={busy}
      onclick={onsend}
    >
      <ShareSquareIcon class="size-icon-lg" />
    </button>
    <ReportButton subject="photo" size="header" onclick={onreport} />
    <button
      class="text-error hover:text-error duration-short ease-standard p-2 transition-colors"
      aria-label="Delete photo"
      onclick={ondeleterequest}
    >
      <TrashIcon class="size-icon-lg" />
    </button>
  </div>

  {#if showDeleteConfirm}
    <ConfirmDialog
      title="Delete Photo?"
      message="Are you sure you want to delete this photo?"
      confirmText="Delete"
      isLoading={busy}
      oncancel={ondeletecancel}
      onconfirm={ondeleteconfirm}
    />
  {/if}
</div>
