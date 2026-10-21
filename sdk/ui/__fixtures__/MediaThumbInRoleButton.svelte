<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  /**
   * A thumb inside a `role="button"` that handles its own keys (MICA-405) — Messages'
   * location card, which acts on Enter in `onkeydown` rather than through a click. The
   * browser turns no key into a click here, so the gate has to see the key itself.
   */
  import MediaThumb from '../MediaThumb.svelte';
  import type { MediaPreview } from '@mica/shared/types';

  const { item, onactivate }: { item: MediaPreview; onactivate: () => void } = $props();
</script>

<div
  role="button"
  tabindex="0"
  data-testid="card"
  onclick={onactivate}
  onkeydown={(event) => {
    if (event.key === 'Enter' || event.key === ' ') onactivate();
  }}
>
  <MediaThumb {item} />
</div>
