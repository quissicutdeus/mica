<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import {
    SettingsSection,
    useKeybinds,
    useKeybindsWrite,
    useLocale,
    usePhoneNotification
  } from '@gos/sdk';

  const { t } = useLocale();
  const { bindings, groups, findConflict } = useKeybinds();
  const { setBinding, resetBindings } = useKeybindsWrite();
  const { toast } = usePhoneNotification();

  /** The action currently waiting for a key, if any. */
  let capturingId = $state<string | null>(null);

  /** `' '` renders as nothing at all, and a bare letter reads better capitalised. */
  const describeKey = (key: string) => {
    if (key === ' ') return $t('settings.shortcuts.space');
    return key.length === 1 ? key.toUpperCase() : key;
  };

  /**
   * Read the next keypress as the new binding.
   *
   * Bound on the window while capturing, in the capture phase, so the press is claimed
   * before the shell dispatcher can act on the *old* binding — otherwise rebinding
   * `back` would navigate away the moment you pressed Escape.
   */
  const captureKey = (event: KeyboardEvent) => {
    if (!capturingId) return;
    event.preventDefault();
    event.stopPropagation();

    // Escape cancels, except when Escape is the thing being rebound.
    if (event.key === 'Escape' && capturingId !== 'back') {
      capturingId = null;
      return;
    }

    // Modifiers alone are legitimate bindings (freelook is Alt), so there is nothing to
    // filter out here beyond the empty case.
    const key = event.key;
    if (!key) return;

    const conflict = findConflict(capturingId, key);
    if (conflict) {
      toast.show({
        type: 'error',
        app: 'settings',
        message: $t('settings.shortcuts.conflict', {
          key: describeKey(key),
          label: conflict.label
        })
      });
      capturingId = null;
      return;
    }

    setBinding(capturingId, key);
    capturingId = null;
  };

  $effect(() => {
    if (!capturingId) return;
    window.addEventListener('keydown', captureKey, true);
    return () => window.removeEventListener('keydown', captureKey, true);
  });
</script>

{#snippet resetAction()}
  <button
    type="button"
    onclick={resetBindings}
    class="text-on-surface-variant hover:text-on-surface duration-short ease-standard text-label-small cursor-pointer rounded-chip px-1.5 py-0.5 normal-case transition-colors"
  >
    {$t('settings.shortcuts.reset')}
  </button>
{/snippet}

<div class="p-4">
  <!-- Only in-phone keys live here. Opening the phone is a FiveM key mapping, so it is
       rebound in the game's own Key Bindings menu — while the phone is open the game
       receives no control input, and a mapping could never fire. -->
  <SettingsSection
    title={$t('settings.shortcuts.title')}
    headerAction={resetAction}
    footer={$t('settings.shortcuts.footer')}
  >
    {#each $groups as group (group.ownerId)}
      {#if group.ownerId !== 'core'}
        <h3
          class="text-on-surface-variant text-label-small px-4 pt-3 pb-1 tracking-wider uppercase"
        >
          {group.ownerLabel}
        </h3>
      {/if}
      <div class="divide-outline-variant text-body-medium divide-y">
        {#each group.actions as action (action.id)}
          <button
            type="button"
            data-testid="shortcut-{action.id}"
            onclick={() => (capturingId = action.id)}
            class="hover:bg-surface-container-high duration-short ease-standard flex w-full cursor-pointer items-center justify-between p-4 text-left transition-colors"
          >
            <span class="text-on-surface font-medium">{action.label}</span>
            {#if capturingId === action.id}
              <span
                class="text-secondary text-body-small animate-pulse rounded-chip border border-indigo-600 bg-indigo-950 px-2 py-0.5 font-mono"
              >
                {$t('settings.shortcuts.pressKey')}
              </span>
            {:else}
              <span
                class="bg-surface text-on-surface text-body-small rounded-chip px-2 py-0.5 font-mono"
              >
                {describeKey($bindings[action.id])}
              </span>
            {/if}
          </button>
        {/each}
      </div>
    {/each}
  </SettingsSection>
</div>
