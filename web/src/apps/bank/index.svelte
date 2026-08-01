<script lang="ts">
  import { EmptyState, Screen, onAppMount, useAccount } from '@gphone/sdk';
  import CreditCard from './components/CreditCard.svelte';
  import TransactionItem from './components/TransactionItem.svelte';

  let { onback } = $props();

  const { bankBalance, transactions, citizenid, fetchBalance, fetchTransactions, fetchCitizenId } =
    useAccount();

  // `onAppMount`, not `$effect`. An effect re-runs whenever anything it reads changes,
  // so the first `$state` read added inside this block would turn it into a fetch loop.
  onAppMount(() => {
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
      {#each $transactions as transaction}
        <TransactionItem {transaction} />
      {:else}
        <EmptyState
          title="No transactions"
          description="Nothing has moved through this account yet."
        />
      {/each}
    </div>
  </div>
</Screen>
