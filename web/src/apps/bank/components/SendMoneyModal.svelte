<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import {
    Button,
    CloseIcon,
    formatCurrency,
    useBank,
    useLocale,
    type SendMoneyOutcome,
    fade
  } from '@gphone/sdk';

  const { t } = useLocale();

  interface Props {
    balance: number;
    onsent: (amount: number) => void;
    onclose: () => void;
  }

  let { balance, onsent, onclose }: Props = $props();

  const { sendMoney } = useBank();

  let phone = $state('');
  let amount = $state<number | ''>('');
  let note = $state('');
  let busy = $state(false);
  // Distinct from `error`: a refused outcome is a normal answer from the server, worth
  // showing beside the form so the player can correct it. A thrown error means the
  // request never got a real answer at all.
  let refusal = $state<SendMoneyOutcome | null>(null);
  let error = $state('');

  const canSend = $derived(
    phone.trim().length > 0 &&
      amount !== '' &&
      Number.isInteger(Number(amount)) &&
      Number(amount) > 0 &&
      !busy
  );

  // One line per reason, rather than one generic failure message — the whole point of
  // `sendMoney` returning a discriminated outcome instead of a boolean.
  const REFUSAL_MESSAGE: Record<Exclude<SendMoneyOutcome, { ok: true }>['reason'], string> =
    $derived({
      invalid_amount: $t('bank.refusalInvalidAmount'),
      exceeds_limit: $t('bank.refusalExceedsLimit'),
      same_player: $t('bank.refusalSamePlayer'),
      payer_offline: $t('bank.refusalPayerOffline'),
      recipient_offline: $t('bank.refusalRecipientOffline'),
      insufficient_funds: $t('bank.refusalInsufficientFunds'),
      debit_failed: $t('bank.refusalDebitFailed'),
      credit_failed: $t('bank.refusalCreditFailed'),
      stranded: $t('bank.refusalStranded')
    });

  const submit = async () => {
    if (!canSend) return;
    busy = true;
    refusal = null;
    error = '';
    try {
      const outcome = await sendMoney({
        phone: phone.trim(),
        amount: Number(amount),
        note: note.trim() || undefined
      });
      if (outcome.ok) {
        onsent(outcome.amount);
      } else {
        refusal = outcome;
      }
    } catch (e) {
      error = e instanceof Error ? e.message : $t('bank.networkError');
    } finally {
      busy = false;
    }
  };
</script>

<div
  class="bg-scrim absolute inset-0 z-50 flex items-center justify-center p-6 backdrop-blur-sm"
  transition:fade
>
  <div class="bg-surface-container shadow-elevation-5 w-full rounded-box p-6">
    <div class="mb-4 flex items-center justify-between">
      <h3 class="text-on-surface text-xl font-bold">{$t('bank.sendMoney')}</h3>
      <button
        type="button"
        onclick={onclose}
        aria-label={$t('bank.close')}
        class="text-on-surface-variant hover:text-on-surface cursor-pointer rounded-full p-1"
      >
        <CloseIcon class="size-icon-md" />
      </button>
    </div>

    <p class="text-on-surface-variant text-body-small mb-4">
      {$t('bank.availableBalance', { balance: formatCurrency(balance) })}
    </p>

    <div class="flex flex-col gap-3">
      <input
        type="tel"
        placeholder={$t('bank.phonePlaceholder')}
        bind:value={phone}
        disabled={busy}
        class="bg-surface text-on-surface placeholder-on-surface-variant rounded-box px-3 py-2"
      />
      <input
        type="number"
        min="1"
        step="1"
        placeholder={$t('bank.amountPlaceholder')}
        bind:value={amount}
        disabled={busy}
        class="bg-surface text-on-surface placeholder-on-surface-variant rounded-box px-3 py-2"
      />
      <input
        type="text"
        placeholder={$t('bank.notePlaceholder')}
        maxlength="140"
        bind:value={note}
        disabled={busy}
        class="bg-surface text-on-surface placeholder-on-surface-variant rounded-box px-3 py-2"
      />
    </div>

    {#if refusal && !refusal.ok}
      <p class="text-error text-body-small mt-3" role="alert">
        {REFUSAL_MESSAGE[refusal.reason]}
      </p>
    {/if}
    {#if error}
      <p class="text-error text-body-small mt-3" role="alert">{error}</p>
    {/if}

    <div class="mt-4 flex gap-3">
      <Button class="flex-1" variant="secondary" onclick={onclose} disabled={busy}
        >{$t('bank.cancel')}</Button
      >
      <Button class="flex-1" onclick={submit} disabled={!canSend}>
        {busy ? $t('bank.sending') : $t('bank.send')}
      </Button>
    </div>
  </div>
</div>
