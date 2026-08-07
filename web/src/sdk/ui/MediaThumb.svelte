<script lang="ts">
  import type { MediaItem } from '@shared/types';
  import DocumentIcon from './icons/DocumentIcon.svelte';
  import LinkIcon from './icons/LinkIcon.svelte';
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
   * **No `<video>` element, deliberately.** The game runs Chromium 103 and a video would
   * have to arrive as base64 through the NUI bridge, which §-the-roadmap already records
   * as not viable. So video renders as its poster frame with a play affordance — honest
   * about what it is without promising playback that does not exist yet. When a real
   * playback path arrives, this is the one file that changes.
   */
  interface Props {
    item: MediaItem;
    /** `grid` fills its container; `full` fits inside it. */
    fit?: 'cover' | 'contain';
    class?: string;
    alt?: string;
  }

  let { item, fit = 'cover', class: className = '', alt }: Props = $props();

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
   * `thumbnail` first: for a video it is the only thing that renders at all, and for a
   * heavy GIF it is the cheaper frame. `data` next, because that is where a local capture
   * puts its bytes. `url` last, and only where it is an image.
   */
  let still = $derived(
    safe(item.thumbnail) ??
      safe(item.data) ??
      (URL_IS_AN_IMAGE.has(item.kind) ? safe(item.url) : undefined)
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
        <MicrophoneIcon class="h-6 w-6" />
      {:else if item.kind === 'link'}
        <LinkIcon class="h-6 w-6" />
      {:else}
        <DocumentIcon class="h-6 w-6" />
      {/if}
      <span class="w-full truncate text-center text-[10px]">{label}</span>
    </div>
  {/if}

  {#if item.kind === 'video'}
    <!-- Centred over the poster. The badge is the whole affordance, since there is no
         playback behind it yet — it says "this is a video", not "press to play". -->
    <div class="pointer-events-none absolute inset-0 flex items-center justify-center">
      <div class="bg-media-overlay rounded-full p-2">
        <PlayIcon class="h-5 w-5 text-white" />
      </div>
    </div>
  {/if}

  {#if item.kind === 'gif'}
    <span
      class="bg-media-overlay pointer-events-none absolute top-1 left-1 rounded px-1 text-[10px] font-semibold text-white"
    >
      GIF
    </span>
  {/if}

  {#if item.duration_ms}
    <span
      class="bg-media-overlay pointer-events-none absolute right-1 bottom-1 rounded px-1 text-[10px] font-medium text-white"
    >
      {seconds(item.duration_ms)}
    </span>
  {/if}
</div>
