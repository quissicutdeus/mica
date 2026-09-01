<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  /**
   * Passcode and auto-lock policy (MICA-60).
   *
   * The passcode itself never lands in this component's own state for longer than the
   * moment it takes to submit it — no `usePersisted`, no browser storage, matching the
   * ticket's own reading of the feature: "the lock is a display state, not a security
   * boundary," so the one thing that has to be handled carefully is not pretending
   * otherwise. `useLockScreenWrite().setPasscode` is one round trip to a server action that
   * does not exist yet (`PENDING (Cody)` on `shared/routes.ts`'s four `lockscreen` routes) —
   * `web/src/nui/mocks/registry.ts` answers it in the browser today.
   */
  import { SettingsSection, useAppAction, useLockScreen, useLockScreenWrite } from '@gphone/sdk';

  const { hasPasscode, autoLockPolicy, autoLockPolicyChoices } = useLockScreen();
  const { setAutoLockPolicy, setPasscode, clearPasscode } = useLockScreenWrite();
  const { busy, run } = useAppAction('settings');

  let editing = $state(false);
  let digits = $state('');
  let confirmDigits = $state('');
  let showClearConfirm = $state(false);

  const MIN_DIGITS = 4;
  const MAX_DIGITS = 6;

  const digitsOnly = (value: string) => value.replace(/\D/g, '').slice(0, MAX_DIGITS);

  const startEditing = () => {
    digits = '';
    confirmDigits = '';
    editing = true;
  };

  const canSave = $derived(
    digits.length >= MIN_DIGITS &&
      digits.length === confirmDigits.length &&
      digits === confirmDigits
  );

  const savePasscode = async () => {
    if (!canSave) return;
    const ok = await run(() => setPasscode(digits), {
      success: $hasPasscode ? 'Passcode changed' : 'Passcode set'
    });
    if (!ok) return;
    editing = false;
    digits = '';
    confirmDigits = '';
  };

  const removePasscode = async () => {
    await run(() => clearPasscode(), { success: 'Passcode removed' });
    showClearConfirm = false;
  };
</script>

<div class="space-y-6 p-4">
  <SettingsSection title="Passcode">
    <div class="space-y-3 p-4">
      {#if editing}
        <p class="text-on-surface-variant text-body-small">
          {MIN_DIGITS}–{MAX_DIGITS} digits. Entered twice, so a typo does not lock you out of your own
          phone.
        </p>
        <input
          type="password"
          inputmode="numeric"
          class="bg-surface-container-low placeholder-on-surface-variant border-outline-variant text-on-surface text-body-medium w-full rounded-chip border p-2"
          placeholder="New passcode"
          value={digits}
          oninput={(e) => (digits = digitsOnly(e.currentTarget.value))}
          disabled={$busy}
        />
        <input
          type="password"
          inputmode="numeric"
          class="bg-surface-container-low placeholder-on-surface-variant border-outline-variant text-on-surface text-body-medium w-full rounded-chip border p-2"
          placeholder="Confirm passcode"
          value={confirmDigits}
          oninput={(e) => (confirmDigits = digitsOnly(e.currentTarget.value))}
          disabled={$busy}
        />
        {#if confirmDigits.length > 0 && digits !== confirmDigits.slice(0, digits.length)}
          <p class="text-error text-body-small">Does not match yet.</p>
        {/if}
        <div class="flex gap-2">
          <button
            type="button"
            class="border-outline-variant text-on-surface hover:bg-surface-container-high duration-short ease-standard flex-1 rounded-full border py-2 text-center font-medium transition-colors"
            onclick={() => (editing = false)}
            disabled={$busy}
          >
            Cancel
          </button>
          <button
            type="button"
            class="bg-primary-container text-on-primary-container duration-short ease-standard flex-1 rounded-full py-2 text-center font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40"
            onclick={savePasscode}
            disabled={$busy || !canSave}
          >
            {$busy ? 'Saving...' : 'Save'}
          </button>
        </div>
      {:else}
        <div class="flex items-center justify-between">
          <span class="text-on-surface text-body-medium">
            {$hasPasscode ? 'Passcode is set' : 'No passcode set'}
          </span>
        </div>
        <div class="flex gap-2">
          <button
            type="button"
            class="border-outline-variant text-on-surface hover:bg-surface-container-high duration-short ease-standard flex-1 rounded-full border py-2 text-center font-medium transition-colors"
            onclick={startEditing}
          >
            {$hasPasscode ? 'Change Passcode' : 'Set Passcode'}
          </button>
          {#if $hasPasscode}
            <button
              type="button"
              class="border-error text-error hover:bg-error-container duration-short ease-standard flex-1 rounded-full border py-2 text-center font-medium transition-colors"
              onclick={() => (showClearConfirm = true)}
            >
              Remove
            </button>
          {/if}
        </div>
        {#if showClearConfirm}
          <div class="bg-surface-container-high space-y-2 rounded-box p-3">
            <p class="text-on-surface text-body-small">
              Remove your passcode? The lock screen will stop appearing until you set a new one.
            </p>
            <div class="flex gap-2">
              <button
                type="button"
                class="border-outline-variant text-on-surface hover:bg-surface-container duration-short ease-standard flex-1 rounded-full border py-1.5 text-center text-body-small font-medium transition-colors"
                onclick={() => (showClearConfirm = false)}
                disabled={$busy}
              >
                Cancel
              </button>
              <button
                type="button"
                class="bg-error text-on-error duration-short ease-standard flex-1 rounded-full py-1.5 text-center text-body-small font-medium transition-colors"
                onclick={removePasscode}
                disabled={$busy}
              >
                Remove
              </button>
            </div>
          </div>
        {/if}
      {/if}
    </div>
  </SettingsSection>

  <SettingsSection title="Auto-Lock">
    <div class="p-4">
      <div class="grid grid-cols-3 gap-1.5">
        {#each $autoLockPolicyChoices as choice (choice.id)}
          <button
            type="button"
            onclick={() => setAutoLockPolicy(choice.id)}
            aria-pressed={$autoLockPolicy === choice.id}
            class="text-body-small cursor-pointer rounded-chip border py-1.5 transition-all {$autoLockPolicy ===
            choice.id
              ? 'border-primary bg-primary-container text-on-primary-container'
              : 'border-outline-variant bg-surface text-on-surface-variant hover:bg-surface-container-high'} duration-short ease-standard"
          >
            {choice.label}
          </button>
        {/each}
      </div>
      <p class="text-on-surface-variant text-body-small mt-3">
        {$autoLockPolicyChoices.find((choice) => choice.id === $autoLockPolicy)?.description ?? ''}
      </p>
    </div>
  </SettingsSection>
</div>
