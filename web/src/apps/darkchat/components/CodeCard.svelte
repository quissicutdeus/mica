<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { Button, useLocale } from '@mica/sdk';
  import { copyText } from '../clipboard';

  /**
   * A channel's join code, large enough to read aloud, with a copy button. The code stays on
   * screen whether or not the copy worked: inside the sandboxed frame the clipboard is not
   * promised, and reading it off the screen always is.
   */
  let { code }: { code: string } = $props();

  const { t } = useLocale();

  let status = $state<'idle' | 'copied' | 'failed'>('idle');

  const copy = async () => {
    status = (await copyText(code)) ? 'copied' : 'failed';
  };
</script>

<div class="bg-surface-container flex flex-col items-center gap-3 rounded-box p-4">
  <p
    class="text-on-surface text-title-large font-mono tracking-widest break-all"
    data-testid="darkchat-code"
  >
    {code}
  </p>
  <Button variant="secondary" class="w-full" onclick={() => void copy()}>
    {$t('darkchat.copy')}
  </Button>
  {#if status !== 'idle'}
    <p
      class="text-body-small {status === 'copied' ? 'text-on-surface-variant' : 'text-error'}"
      role="status"
    >
      {status === 'copied' ? $t('darkchat.copied') : $t('darkchat.copyFailed')}
    </p>
  {/if}
</div>
