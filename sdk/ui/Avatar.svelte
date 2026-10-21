<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  interface Props {
    initials?: string;
    src?: string;
    size?: string;
    textClass?: string;
    bgClass?: string;
    showSilhouette?: boolean;
  }

  let {
    initials = '',
    src = '',
    size = 'w-10 h-10',
    textClass = 'text-sm',
    bgClass = 'bg-surface-container-high',
    showSilhouette = true
  }: Props = $props();

  let imageError = $state(false);

  const showImage = $derived(!!src && !imageError);
  const showInitials = $derived(!showImage && !showSilhouette && !!initials);
</script>

<!--
  Initials are drawn as generated content, never as a text node (MICA-404). An avatar mostly
  sits inside a control named for where it goes ("Posting as @ada", "Ada's profile"), and
  WCAG 2.5.3 asks that a control's name contain the text it shows. axe-core's
  label-content-name-mismatch collects that text from DOM text nodes alone, so "AD" as a child
  read as visible text missing from the name; aria-hidden does not change that, because the
  rule measures what is painted, not what is announced. A pseudo-element is painted and is no
  text node. Chromium still exposes it to assistive tech as static text, so an avatar standing
  on its own is announced exactly as before, and the image branch keeps its alt.
-->
<div
  class="{size} flex items-center justify-center rounded-full font-bold {bgClass} {textClass} shrink-0 overflow-hidden"
  data-initials={showInitials ? initials : undefined}
>
  {#if showImage}
    <img
      {src}
      alt={initials || 'Avatar'}
      class="h-full w-full object-cover"
      onerror={() => (imageError = true)}
    />
  {:else if !showInitials}
    <svg class="text-on-surface-variant h-2/3 w-2/3 fill-current" viewBox="0 0 24 24">
      <path
        d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"
      />
    </svg>
  {/if}
</div>

<style>
  /* attr() inside content is CSS 2, far below the Chromium 103 floor. */
  [data-initials]::before {
    content: attr(data-initials);
  }
</style>
