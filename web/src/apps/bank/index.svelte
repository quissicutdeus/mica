<script lang="ts">
  import { EmptyState, Screen, Skeleton, onAppForeground, useAccount } from '@gphone/sdk';
  import CreditCard from './components/CreditCard.svelte';
  import TransactionItem from './components/TransactionItem.svelte';

  let { onback } = $props();

  const {
    bankBalance,
    transactions,
    transactionsLoaded,
    citizenid,
    fetchBalance,
    fetchTransactions,
    fetchCitizenId
  } = useAccount();

  // Every time Bank comes to the front, not once per session. Nothing pushes a balance
  // change to the phone, and Bank stays resident, so money spent elsewhere would never
  // show up. Not an `$effect` either: an effect re-runs whenever anything it reads
  // changes, so the first `$state` read added inside this block would turn it into a
  // fetch loop.
  onAppForeground('bank', () => {
    void fetchBalance();
    void fetchTransactions();
    void fetchCitizenId();
  });
</script>

<Screen title="Bank" {onback}>
  <div class="p-4">
    <!-- Card -->
    <CreditCard balance={$bankBalance} citizenid={$citizenid} />

    <!-- Transactions -->
    <h3 class="mb-4 text-lg font-semibold">Recent Transactions</h3>
    <div class="space-y-4">
      {#if !$transactionsLoaded}
        <Skeleton count={3} height="h-14" />
      {:else}
        {#each $transactions as transaction}
          <TransactionItem {transaction} />
        {:else}
          <EmptyState
            title="No transactions"
            description="Nothing has moved through this account yet."
          />
        {/each}
      {/if}
    </div>
  </div>
</Screen>
