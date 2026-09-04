<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { t } from './messages';
  import { EmptyState, Screen } from '@mica/sdk';

  let { title, onback }: { title: string; onback: () => void } = $props();
</script>

<Screen {title} {onback}>
  <div class="flex min-h-0 flex-1 items-center justify-center p-6">
    <EmptyState title={$t('shell.noSignal')} description={$t('shell.noSignalHint')} />
  </div>
</Screen>
