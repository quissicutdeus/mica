<script lang="ts">
  import type { MediaPreview } from '@shared/types';
  import DocumentIcon from './icons/DocumentIcon.svelte';
  import LinkIcon from './icons/LinkIcon.svelte';
  import LocationIcon from './icons/LocationIcon.svelte';
  import MicrophoneIcon from './icons/MicrophoneIcon.svelte';
  import PlayIcon from './icons/PlayIcon.svelte';

  /**
   * One media row, drawn by its `kind`.
   *
   * `gphone_media` holds seven kinds and every surface that shows one — the gallery grid,
   * the full view, the picker, a message attachment — needs the same answer to "what does
   * this look like". Four copies of that answer is four places to forget `kind` exists,
   * which is how a video ends up rendering as a broken `<img>`.
   *
   * **No `<video>` element, deliberately.** A clip has no route to the phone except as
   * base64 through the NUI bridge, and that is not viable at video sizes. So this renders
   * a video as its poster frame with a play affordance — honest
   * about what it is without promising playback that does not exist yet. When a real
   * playback path arrives, this is the one file that changes.
   */
  interface Props {
    item: MediaPreview;
    /** `grid` fills its container; `full` fits inside it. */
    fit?: 'cover' | 'contain';
    /**
     * Which source to reach for first.
     *
     * `'still'` — the default, and what a tile wants: the smallest thing that draws, so a
     * grid does not pull originals to fill 123px squares (MICA-110).
     *
     * `'original'` — what a full-screen view wants: the actual bytes, falling back to the
     * thumbnail only if there are none. Without this the precedence below silently defeats
     * the detail fetch — the viewer pays a round trip for the original and then draws the
     * same small still the grid already drew, upscaled, which looks like a working app.
     *
     * A prop rather than the caller handing over a row with `thumbnail` deleted: stripping
     * a field to steer a fallback chain is a lie about the data, and the next person to read
     * that row construction has no way to know why.
     */
    prefer?: 'still' | 'original';
    class?: string;
    alt?: string;
  }

  let { item, fit = 'cover', prefer = 'still', class: className = '', alt }: Props = $props();

  /**
   * Only schemes that cannot execute.
   *
   * `url` is server-written today (`clientWritable: false`), so this is defence in depth
   * rather than a live hole — but it costs one predicate, and the alternative is trusting
   * that no future feature ever opens the column up. `javascript:` in an `<img src>` is
   * already inert; the rule matters because this value is one refactor away from reaching
   * something that is not an `<img>`, and §7 is emphatic that a link is a griefing vector
   * in CEF.
   */
  const SAFE_SRC = /^(https?:|data:image\/)/i;
  const safe = (value: string | undefined): string | undefined =>
    value && SAFE_SRC.test(value.trim()) ? value : undefined;

  /**
   * Kinds whose `url` is itself an image.
   *
   * The distinction matters and is easy to miss: a voice note's `url` ends in `.ogg` and a
   * video's in `.mp4`, and both pass a scheme check happily — so treating `url` as a
   * fallback still for every kind renders a broken image for exactly the kinds that have
   * no still. For those, `thumbnail` is the only source, and its absence is the signal to
   * draw a placeholder instead.
   */
  const URL_IS_AN_IMAGE = new Set(['photo', 'gif', 'sticker']);

  /**
   * What to draw as a still.
   *
   * At `prefer: 'still'`: `thumbnail` first — for a video it is the only thing that renders
   * at all, and for a heavy GIF it is the cheaper frame. `data` next, because that is where
   * a local capture puts its bytes. `url` last, and only where it is an image.
   *
   * At `prefer: 'original'` the first two swap, and only those two: `url` stays last and
   * stays gated the same way, because which kinds have an image behind a URL is a fact
   * about the row rather than a preference of the caller. A video asked for its original
   * still resolves to its poster, since `data` is empty and its `url` is an `.mp4`.
   */
  const bytes = $derived(safe(item.data));
  const poster = $derived(safe(item.thumbnail));
  const linked = $derived(URL_IS_AN_IMAGE.has(item.kind) ? safe(item.url) : undefined);

  let still = $derived(
    prefer === 'original' ? (bytes ?? poster ?? linked) : (poster ?? bytes ?? linked)
  );

  let label = $derived(alt ?? item.alt_text ?? `${item.kind} ${item.id}`);
  let objectFit = $derived(fit === 'cover' ? 'object-cover' : 'object-contain');

  const seconds = (ms: number) => {
    const total = Math.round(ms / 1000);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  };
</script>

<div class="relative h-full w-full {className}">
  {#if still}
    <img src={still} alt={label} class="h-full w-full {objectFit}" />
  {:else}
    <!-- No still to draw: audio, a file, or a link with no preview image. A labelled
         placeholder rather than a broken image, which is what an <img> with no src is. -->
    <div
      class="bg-surface-container-high text-on-surface-variant flex h-full w-full flex-col items-center justify-center gap-1 p-2"
    >
      {#if item.kind === 'audio'}
        <MicrophoneIcon class="size-icon-lg" />
      {:else if item.kind === 'link'}
        <LinkIcon class="size-icon-lg" />
      {:else if item.kind === 'location'}
        <LocationIcon class="size-icon-lg" />
      {:else}
        <DocumentIcon class="size-icon-lg" />
      {/if}
      <span class="text-label-small w-full truncate text-center">{label}</span>
    </div>
  {/if}

  {#if item.kind === 'video'}
    <!-- Centred over the poster. The badge is the whole affordance, since there is no
         playback behind it yet — it says "this is a video", not "press to play". -->
    <div class="pointer-events-none absolute inset-0 flex items-center justify-center">
      <div class="bg-media-overlay rounded-full p-2">
        <PlayIcon class="size-icon-md text-white" />
      </div>
    </div>
  {/if}

  {#if item.kind === 'gif'}
    <span
      class="bg-media-overlay text-label-small pointer-events-none absolute top-1 left-1 rounded px-1 text-white"
    >
      GIF
    </span>
  {/if}

  {#if item.duration_ms}
    <span
      class="bg-media-overlay text-label-small pointer-events-none absolute right-1 bottom-1 rounded px-1 text-white"
    >
      {seconds(item.duration_ms)}
    </span>
  {/if}
</div>
