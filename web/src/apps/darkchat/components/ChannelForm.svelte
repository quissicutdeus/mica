<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { Button, useLocale } from '@mica/sdk';
  import { ALIAS_MAX, CODE_LENGTH, NAME_MAX, isCode, normalizeCode } from '../store';

  /**
   * Create a channel (a name and my alias in it) or join one (a code and my alias). One form,
   * because the alias half is the same and is the half that matters: it is everything the
   * channel will ever know about me. The server checks every bound again; these are courtesy.
   */
  let {
    mode,
    busy = false,
    onsubmit,
    oncancel
  }: {
    mode: 'create' | 'join';
    busy?: boolean;
    onsubmit: (first: string, alias: string) => void;
    oncancel: () => void;
  } = $props();

  const { t } = useLocale();

  let name = $state('');
  let code = $state('');
  let alias = $state('');

  const valid = $derived(
    alias.trim().length > 0 && (mode === 'create' ? name.trim().length > 0 : isCode(code))
  );

  /**
   * No `<form>` anywhere in this app: the add-on frame is `sandbox="allow-scripts"` without
   * `allow-forms`, so Chromium (CEF included) blocks the submission and its handler never runs.
   * The button is a plain click, and Enter in any field is handled here instead.
   */
  const submit = () => {
    if (!valid || busy) return;
    onsubmit(mode === 'create' ? name.trim() : code, alias.trim());
  };

  /** Enter submits, except while an IME is composing — that Enter commits the composition. */
  const onkeydown = (event: KeyboardEvent) => {
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    submit();
  };
</script>

<div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-6">
  {#if mode === 'create'}
    <label class="flex flex-col gap-1.5">
      <span class="text-on-surface-variant text-label-large">{$t('darkchat.channelName')}</span>
      <input
        {onkeydown}
        bind:value={name}
        maxlength={NAME_MAX}
        placeholder={$t('darkchat.channelNamePlaceholder')}
        autocomplete="off"
        class="bg-surface-container text-on-surface placeholder-on-surface-variant text-body-medium w-full rounded-box px-3 py-2.5 focus:outline-none"
        data-testid="darkchat-name"
      />
    </label>
  {:else}
    <label class="flex flex-col gap-1.5">
      <span class="text-on-surface-variant text-label-large">{$t('darkchat.code')}</span>
      <input
        {onkeydown}
        bind:value={code}
        oninput={() => (code = normalizeCode(code))}
        maxlength={CODE_LENGTH}
        autocomplete="off"
        autocapitalize="characters"
        spellcheck="false"
        class="bg-surface-container text-on-surface placeholder-on-surface-variant text-body-medium w-full rounded-box px-3 py-2.5 focus:outline-none font-mono tracking-widest"
        data-testid="darkchat-join-code"
      />
      <span class="text-on-surface-variant text-body-small">{$t('darkchat.codeHint')}</span>
    </label>
  {/if}

  <label class="flex flex-col gap-1.5">
    <span class="text-on-surface-variant text-label-large">{$t('darkchat.alias')}</span>
    <input
      {onkeydown}
      bind:value={alias}
      maxlength={ALIAS_MAX}
      placeholder={$t('darkchat.aliasPlaceholder')}
      autocomplete="off"
      class="bg-surface-container text-on-surface placeholder-on-surface-variant text-body-medium w-full rounded-box px-3 py-2.5 focus:outline-none"
      data-testid="darkchat-alias"
    />
    <span class="text-on-surface-variant text-body-small">{$t('darkchat.aliasHint')}</span>
  </label>

  <div class="mt-2 flex gap-2">
    <Button type="button" variant="secondary" class="flex-1" disabled={busy} onclick={oncancel}>
      {$t('darkchat.cancel')}
    </Button>
    <Button type="button" class="flex-1" disabled={!valid || busy} onclick={submit}>
      {busy ? '…' : mode === 'create' ? $t('darkchat.create') : $t('darkchat.join')}
    </Button>
  </div>
</div>
