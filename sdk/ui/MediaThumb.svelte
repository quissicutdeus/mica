<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import type { MediaPreview } from '@mica/shared/types';
  import DocumentIcon from './icons/DocumentIcon.svelte';
  import LinkIcon from './icons/LinkIcon.svelte';
  import LocationIcon from './icons/LocationIcon.svelte';
  import MicrophoneIcon from './icons/MicrophoneIcon.svelte';
  import PlayIcon from './icons/PlayIcon.svelte';
  import { t } from '../i18n';
  import './messages';
  import { useStreamerMode } from '../host/useStreamerMode';
  import { isDataImage } from '@mica/shared/imageSource';

  /**
   * One media row, drawn by its `kind`.
   *
   * `mica_media` holds seven kinds and every surface that shows one — the gallery grid,
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
   * At `prefer: 'original'` the original comes first wherever it lives — `data` for a
   * local capture, `url` for a photo on an image host (MICA-243), which has no `data` at all
   * and would otherwise open as its own thumbnail upscaled — and `thumbnail` last. `url`
   * stays gated the same way at both, because which kinds have an image behind a URL is a
   * fact about the row rather than a preference of the caller. A video asked for its
   * original still resolves to its poster, since `data` is empty and its `url` is an `.mp4`.
   */
  /**
   * `data` is inline bytes, so only a `data:image/` URI draws from it — never `https:`
   * (MICA-339). A remote URL in `data` was a beacon: a player stored one on their own row,
   * attached or dropped it, and every phone that drew the tile requested it, handing the host
   * that viewer's IP. The server refuses one on the client path now; this is what keeps a row
   * written before that from still being drawn. A remote image reaches this component only
   * through `url`, which is server-written.
   *
   * Any `data:image/`, not only the camera's two shapes: a `data:` URI fetches nothing, and
   * a row a server resource wrote through `AddMedia` is not held to the camera's encoder.
   */
  const bytes = $derived(isDataImage(item.data) ? item.data : undefined);
  const poster = $derived(safe(item.thumbnail));
  const linked = $derived(URL_IS_AN_IMAGE.has(item.kind) ? safe(item.url) : undefined);

  let still = $derived(
    prefer === 'original' ? (bytes ?? linked ?? poster) : (poster ?? bytes ?? linked)
  );

  let label = $derived(alt ?? item.alt_text ?? `${item.kind} ${item.id}`);
  let objectFit = $derived(fit === 'cover' ? 'object-cover' : 'object-contain');

  const seconds = (ms: number) => {
    const total = Math.round(ms / 1000);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  };

  /**
   * Streamer mode (MICA-249): a still is blurred until tapped, and only here.
   *
   * Every player-supplied picture on the phone draws through this component, which is
   * what makes one implementation enough — a message attachment, a gallery tile, a
   * marketplace photo and a Blab's picture all get the same blur and the same tap, and
   * an app has nothing to remember. The hook is implicit (`PERMISSION_OF`), so rendering
   * this costs an app no permission it did not already have.
   *
   * `revealed` is this instance's own: a detail view mounts fresh and starts hidden. It
   * is also cleared on every bump of `revealGeneration`, which is how a thumb that stays
   * mounted in a resident app — Media's grid, a Messages thread — hides again when the
   * flag flips, the foreground app changes or the device closes.
   *
   * The reveal is a tap that goes no further. Most thumbs sit inside a button that opens
   * the picture, and a first tap on a blurred one must not also open it — that would put
   * the full-size original on screen, which is the exact thing the mode exists to stop.
   * The second tap reaches the parent as before.
   *
   * **Who owns the reveal depends on where the thumb is drawn (MICA-405).** Ten of the
   * nineteen call sites put it inside a control — a grid tile, a picker cell, a message
   * bubble — and an interactive element inside one is invalid ARIA whatever its tag: the
   * `role="button"` overlay this used to draw gave a second tab stop and muddled the
   * parent's name. So:
   *
   * - **Inside a control**, that control is the gate. While the still is blurred, a
   *   capture-phase listener on it turns its own activation into the reveal — a click,
   *   which is also what Enter and Space on a native button dispatch, and Enter or Space
   *   on a `role="button"` that handles its keys itself. Capture on the control runs
   *   before the control's own listeners and before Svelte's delegated root, so the
   *   caller's handler never sees the first activation. The control is described as
   *   "Tap to reveal" through `aria-describedby`, and the overlay is painted only:
   *   `aria-hidden`, its label generated content, so the control's name is unchanged and
   *   axe's visible-text check (`label-content-name-mismatch`) has no text node to read.
   * - **Standalone** — a Blab's picture, the full view, a composer's attachment — there is
   *   nothing to nest inside, so the overlay is a real `<button>`.
   *
   * Found by walking up the DOM rather than by a prop, so no caller had to change, and an
   * add-on's own button gets the same gate. A click inside one blurred still reveals that
   * one; any other activation of the control reveals every still it holds, since none of
   * them should be acted on unseen. A click that belongs to another control nested inside
   * this one — a quoted reply in a message bubble — is left alone.
   */
  const { streamerMode, revealGeneration } = useStreamerMode();
  let revealed = $state(false);
  $effect(() => {
    void $revealGeneration;
    revealed = false;
  });

  let hidden = $derived($streamerMode && !!still && !revealed);
  /** What the tests and the e2e specs read; absent when the mode is off. */
  let streamerState = $derived(
    $streamerMode && still ? (revealed ? 'revealed' : 'blurred') : undefined
  );

  /** What counts as a control, for nesting. Widget roles that are activated, plus native. */
  const CONTROL =
    'button, a[href], summary, [role="button"], [role="link"], [role="menuitem"], ' +
    '[role="menuitemcheckbox"], [role="menuitemradio"], [role="option"], [role="tab"], ' +
    '[role="checkbox"], [role="radio"], [role="switch"]';
  /** Controls whose Enter and Space the browser already turns into a click. */
  const CLICKS_FROM_KEYS = 'button, a[href], summary';

  const describedBy = $props.id();
  let root: HTMLDivElement | undefined = $state();
  /** The control this thumb is drawn inside: `null` when none, `undefined` until mounted. */
  let control: HTMLElement | null | undefined = $state.raw(undefined);
  $effect(() => {
    control = root?.parentElement?.closest<HTMLElement>(CONTROL) ?? (root ? null : undefined);
  });

  $effect(() => {
    const host = control;
    if (!hidden || !host) return;

    /** Whether this event is the control's own, not a nested control's. */
    const owns = (event: Event) =>
      event.target instanceof Element && event.target.closest(CONTROL) === host;
    const gate = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      const hit = (event.target as Element).closest('[data-streamer="blurred"]');
      if (!hit || hit === root) revealed = true;
    };
    const onClick = (event: MouseEvent) => {
      if (owns(event)) gate(event);
    };
    const onKey = (event: KeyboardEvent) => {
      if ((event.key === 'Enter' || event.key === ' ') && owns(event)) gate(event);
    };

    host.addEventListener('click', onClick, true);
    const keys = !host.matches(CLICKS_FROM_KEYS);
    if (keys) host.addEventListener('keydown', onKey, true);

    const tokens = (host.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
    if (!tokens.includes(describedBy)) {
      host.setAttribute('aria-describedby', [...tokens, describedBy].join(' '));
    }

    return () => {
      host.removeEventListener('click', onClick, true);
      if (keys) host.removeEventListener('keydown', onKey, true);
      const rest = (host.getAttribute('aria-describedby') ?? '')
        .split(/\s+/)
        .filter((token) => token && token !== describedBy);
      if (rest.length > 0) host.setAttribute('aria-describedby', rest.join(' '));
      else host.removeAttribute('aria-describedby');
    };
  });

  const reveal = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    revealed = true;
  };
</script>

<div
  bind:this={root}
  class="relative h-full w-full {hidden ? 'overflow-hidden' : ''} {className}"
  data-streamer={streamerState}
>
  {#if still}
    <img src={still} alt={label} class="h-full w-full {objectFit} {hidden ? 'blur-media' : ''}" />
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

  {#if hidden && control === null}
    <button
      type="button"
      class="absolute inset-0 z-10 flex cursor-pointer items-center justify-center"
      onclick={reveal}
    >
      <span class="bg-media-overlay text-label-small rounded-chip px-2 py-1 text-white">
        {$t('ui.revealMedia')}
      </span>
    </button>
  {:else if hidden}
    <!-- Inside a control, or not yet known to be outside one: paint only. The control is
         the gate, and the words reach a screen reader as its description below. -->
    <div
      aria-hidden="true"
      class="absolute inset-0 z-10 flex cursor-pointer items-center justify-center"
    >
      <span
        class="bg-media-overlay text-label-small rounded-chip px-2 py-1 text-white"
        data-reveal-label={$t('ui.revealMedia')}
      ></span>
    </div>
    {#if control}
      <span id={describedBy} hidden>{$t('ui.revealMedia')}</span>
    {/if}
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
      class="bg-media-overlay text-label-small pointer-events-none absolute top-1 left-1 rounded-chip px-1 text-white"
    >
      {$t('ui.gif')}
    </span>
  {/if}

  {#if item.duration_ms}
    <span
      class="bg-media-overlay text-label-small pointer-events-none absolute right-1 bottom-1 rounded-chip px-1 text-white"
    >
      {seconds(item.duration_ms)}
    </span>
  {/if}
</div>

<style>
  /* The overlay's words inside a control, as generated content: a text node there would be
     visible text the control's name does not contain (WCAG 2.5.3, MICA-404). attr() in
     content is CSS 2, far below the Chromium 103 floor. */
  [data-reveal-label]::before {
    content: attr(data-reveal-label);
  }
</style>
