<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import Button from './Button.svelte';
  import { t } from '../i18n';
  import './messages';

  /**
   * Claim a handle (MICA-416), once: Blabber and Glimpse each drew this word for word.
   *
   * `oncancel` is optional, and its absence is the point. As the **gate**, shown while the
   * player holds no account at all, there is nothing behind it to go back to, so a Cancel
   * would dismiss the only thing on screen. As the **claim another** overlay, reached from
   * `AccountMenu`, it must be leaveable on screen, so the caller passes `oncancel`.
   *
   * Laid out to fill its parent (`flex-1`); the caller decides whether that is the whole app
   * or an overlay over it.
   */
  interface Props {
    busy?: boolean;
    /** The typed handle, lowercase, already matching the pattern below. */
    onclaim: (handle: string) => void;
    /** Pass it to draw Cancel; leave it out where there is nowhere to go back to. */
    oncancel?: () => void;
    /** "Pick a handle" in the phone's language by default. */
    title?: string;
    /** The line under the title — the app's own "this is how people find you on …". */
    hint?: string;
  }

  let {
    busy = false,
    onclaim,
    oncancel = undefined,
    title = undefined,
    hint = undefined
  }: Props = $props();

  const heading = $derived(title ?? $t('ui.pickHandle'));
  const hintText = $derived(hint ?? $t('ui.pickHandleHint'));

  let handle = $state('');

  /** Mirrors `HANDLE_PATTERN` on the server. The server is the boundary; this is the courtesy. */
  const valid = $derived(/^[a-z0-9_]{3,32}$/.test(handle));
</script>

<div class="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
  <h2 class="text-on-surface text-lg font-bold">{heading}</h2>
  <p class="text-on-surface-variant text-body-small">{hintText}</p>

  <div class="bg-surface-container flex w-full items-center gap-1 rounded-box px-3">
    <span class="text-on-surface-variant text-body-medium">@</span>
    <input
      bind:value={handle}
      maxlength="32"
      aria-label={heading}
      placeholder={$t('ui.handlePlaceholder')}
      autocapitalize="none"
      class="text-on-surface placeholder-on-surface-variant text-body-medium w-full bg-transparent py-2.5 focus:outline-none"
      oninput={() => (handle = handle.toLowerCase())}
    />
  </div>

  <div class="flex w-full gap-2">
    {#if oncancel}
      <Button variant="secondary" class="flex-1" disabled={busy} onclick={oncancel}
        >{$t('ui.cancel')}</Button
      >
    {/if}
    <Button disabled={!valid || busy} class="flex-1" onclick={() => onclaim(handle)}>
      {busy ? '…' : $t('ui.claim')}
    </Button>
  </div>
</div>
