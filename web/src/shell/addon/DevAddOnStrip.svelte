<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import type { Translate } from '../../../../sdk/i18n';
  import { MICA_DEV_ADDON_MARKER } from '@mica/shared/addonDev';
  import { devAddOn, reloadDevAddOn } from './devAddOn';

  /**
   * The shell's line above a dev add-on's frame (MICA-311): where it came from, that it was
   * not verified, and a Reload. Drawn by the shell in its own document, outside the frame,
   * so nothing the add-on renders can cover or restyle it. Renders nothing for any other app.
   *
   * `t` is a prop, not an import of the shell's `messages`: that value import is what split
   * the shell's modules into a shared chunk and broke DEV boot (see `devAddOn.ts`).
   */
  let { appId, t }: { appId: string; t: Translate } = $props();

  const state = $derived($devAddOn && $devAddOn.appId === appId ? $devAddOn : null);
</script>

{#if state}
  <div
    data-testid={MICA_DEV_ADDON_MARKER}
    class="pt-safe-top flex shrink-0 flex-col gap-1 px-4 pb-2 text-xs"
    class:bg-primary-container={!state.error}
    class:text-on-primary-container={!state.error}
    class:bg-error-container={!!state.error}
    class:text-on-error-container={!!state.error}
    role="status"
  >
    <div class="flex items-center justify-between gap-2">
      <span class="min-w-0 truncate font-medium">
        {t('shell.devAddOnFrom', { source: state.source })}
      </span>
      <button
        type="button"
        data-testid="{MICA_DEV_ADDON_MARKER}-reload"
        class="bg-primary text-on-primary shrink-0 rounded-full px-3 py-1 font-medium disabled:opacity-50"
        disabled={state.busy}
        onclick={() => void reloadDevAddOn()}
      >
        {state.busy ? t('shell.devAddOnReloading') : t('shell.devAddOnReload')}
      </button>
    </div>
    {#if state.error}
      <p data-testid="{MICA_DEV_ADDON_MARKER}-error" class="break-words">{state.error}</p>
    {/if}
  </div>
{/if}
