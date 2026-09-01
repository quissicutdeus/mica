<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { EmptyState, Screen } from '@gphone/sdk';

  let { title, onback }: { title: string; onback: () => void } = $props();
</script>

<Screen {title} {onback}>
  <div class="flex min-h-0 flex-1 items-center justify-center p-6">
    <EmptyState
      title="No Signal"
      description="This app needs a cellular connection. Reconnect to service to continue."
    />
  </div>
</Screen>
