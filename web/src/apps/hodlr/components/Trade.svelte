<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { Button, useAppAction, useLocale } from '@gphone/sdk';
  import { useHodlr, buyPriceOf, sellPriceOf } from '../store';

  let { side, onback }: { side: 'buy' | 'sell'; onback: () => void } = $props();

  const { priceStore, portfolioStore, buy, sell, tradeFailureMessage } = useHodlr();
  const { busy, run } = useAppAction('hodlr');
  const { t } = useLocale();

  let quantity = $state<number | ''>('');

  /**
   * The side actually being traded, not the mid/reference — buying and selling are
   * genuinely different numbers once a spread exists (MICA-147/MICA-149), and pricing
   * both sides off `current` was the bug: a buy quoted here at the sell price undercharges
   * whatever the server actually settles at.
   */
  const price = $derived(side === 'buy' ? buyPriceOf($priceStore) : sellPriceOf($priceStore));
  /**
   * The market is closed until it has restored its price after a restart (MICA-130). The
   * Portfolio screen already disables the buttons that reach here, so this is the second
   * guard rather than the first — worth having because the screen stays mounted while the
   * market state can change underneath it, and because the server refuses independently.
   */
  const open = $derived($priceStore.ready);
  const total = $derived(quantity === '' ? 0 : Number(quantity) * price);
  const maxSell = $derived($portfolioStore.quantity);

  /**
   * Why the message exists at all, and not just the `disabled` flag: a greyed-out Confirm
   * with nothing beside it is indistinguishable from a broken one. MICA-99 was reported
   * as "clicking Confirm silently does nothing" — the guard was already refusing the
   * click, it just never said why.
   */
  const validation = $derived.by(() => {
    if (!open) return tradeFailureMessage('market_unavailable', maxSell);
    if (quantity === '') return '';
    const entered = Number(quantity);
    if (!Number.isInteger(entered) || entered <= 0) return $t('hodlr.wholeNumber');
    if (side === 'sell' && entered > maxSell)
      return tradeFailureMessage('insufficient_holdings', maxSell);
    return '';
  });

  const canSubmit = $derived(open && quantity !== '' && validation === '' && !$busy);

  const submit = async () => {
    const amount = Number(quantity);
    const traded = await run(
      async () => {
        const outcome = side === 'buy' ? await buy(amount) : await sell(amount);
        // `buy`/`sell` answer with an outcome rather than throwing, so the refusal is
        // turned into one here — that is what `run` toasts and what makes the server's
        // own refusal visible when the guard above was bypassed or raced a price tick.
        if (!outcome.ok) throw new Error(tradeFailureMessage(outcome.reason, maxSell));
      },
      { title: $t('hodlr.title') }
    );
    if (traded) onback();
  };
</script>

<div class="flex flex-col gap-3 p-4">
  <p class="text-on-surface-variant text-body-medium">
    {#if open}
      {side === 'buy' ? $t('hodlr.quoteBuy', { price }) : $t('hodlr.quoteSell', { price })}
    {:else}
      {side === 'buy' ? $t('hodlr.quoteBuyClosed') : $t('hodlr.quoteSellClosed')}
    {/if}
  </p>

  <input
    placeholder={$t('hodlr.quantityPlaceholder')}
    type="number"
    min="1"
    bind:value={quantity}
    class="bg-surface-container text-on-surface rounded-box px-3 py-2"
  />

  {#if side === 'sell'}
    <p class="text-on-surface-variant text-body-small">
      {$t('hodlr.youHoldAmount', { quantity: maxSell })}
    </p>
  {/if}

  <p class="text-on-surface text-body-large">
    {side === 'buy' ? $t('hodlr.cost', { total }) : $t('hodlr.proceeds', { total })}
  </p>

  {#if validation}
    <p class="text-error text-body-small">{validation}</p>
  {/if}

  <div class="flex justify-end gap-2">
    <Button variant="secondary" onclick={onback}>{$t('hodlr.cancel')}</Button>
    <Button disabled={!canSubmit} onclick={submit}>{$t('hodlr.confirm')}</Button>
  </div>
</div>
