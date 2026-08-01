<script lang="ts">
  import { useAccount, Screen } from '@gphone/sdk';
  import CreditCard from './components/CreditCard.svelte';
  import TransactionItem from './components/TransactionItem.svelte';

  let { onback } = $props();

  const { bankBalance, transactions, citizenid, fetchBalance, fetchTransactions, fetchCitizenId } =
    useAccount();

  $effect(() => {
    fetchBalance();
    fetchTransactions();
    fetchCitizenId();
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
      {/each}
    </div>
  </div>
</Screen>
