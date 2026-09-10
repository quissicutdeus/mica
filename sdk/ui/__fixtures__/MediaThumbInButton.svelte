<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  /**
   * The shape most thumbs are rendered in (MICA-249): inside a button that opens the
   * picture — Media's grid tile, a Snatchr feed card. Svelte 5 delegates `onclick`, so
   * whether a reveal tap reaches that parent is a question only a Svelte parent can
   * answer; a raw listener on the mount container is not the same path.
   */
  import MediaThumb from '../MediaThumb.svelte';
  import type { MediaPreview } from '@mica/shared/types';

  const { item, onopen }: { item: MediaPreview; onopen: () => void } = $props();
</script>

<button type="button" data-testid="opener" onclick={onopen}>
  <MediaThumb {item} />
</button>
