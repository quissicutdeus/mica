<script lang="ts">
  import { Button } from '@gphone/sdk';
  import { useHodlr } from '../store';

  let { side, onback }: { side: 'buy' | 'sell'; onback: () => void } = $props();

  const { priceStore, portfolioStore, buy, sell } = useHodlr();

  let quantity = $state<number | ''>('');
  let busy = $state(false);
  let error = $state('');

  const price = $derived($priceStore.current);
  const total = $derived(quantity === '' ? 0 : Number(quantity) * price);
  const maxSell = $derived($portfolioStore.quantity);

  const canSubmit = $derived(
    quantity !== '' &&
      Number.isInteger(Number(quantity)) &&
      Number(quantity) > 0 &&
      (side === 'buy' || Number(quantity) <= maxSell) &&
      !busy
  );

  const submit = async () => {
    busy = true;
    error = '';
    try {
      const outcome = side === 'buy' ? await buy(Number(quantity)) : await sell(Number(quantity));
      if (outcome.ok) {
        onback();
      } else {
        error = outcome.reason;
      }
    } finally {
      busy = false;
    }
  };
</script>

<div class="flex flex-col gap-3 p-4">
  <p class="text-on-surface-variant text-body-medium">
    {side === 'buy' ? 'Buy' : 'Sell'} gCoin at ${price} each
  </p>

  <input
    placeholder="Quantity"
    type="number"
    min="1"
    bind:value={quantity}
    class="bg-surface-container text-on-surface rounded-lg px-3 py-2"
  />

  {#if side === 'sell'}
    <p class="text-on-surface-variant text-body-small">You hold {maxSell} gCoin.</p>
  {/if}

  <p class="text-on-surface text-body-large">
    {side === 'buy' ? 'Cost' : 'Proceeds'}: ${total}
  </p>

  {#if error}
    <p class="text-error text-body-small">{error}</p>
  {/if}

  <div class="flex justify-end gap-2">
    <Button variant="secondary" onclick={onback}>Cancel</Button>
    <Button disabled={!canSubmit} onclick={submit}>Confirm</Button>
  </div>
</div>
