<script lang="ts">
  import {
    Button,
    EmptyState,
    Screen,
    Skeleton,
    onAppForeground,
    useAccount,
    usePhoneNotification,
    type AppProps
  } from '@gphone/sdk';
  import CreditCard from './components/CreditCard.svelte';
  import TransactionItem from './components/TransactionItem.svelte';
  import SendMoneyModal from './components/SendMoneyModal.svelte';

  let { onback }: AppProps = $props();

  const {
    bankBalance,
    transactions,
    transactionsLoaded,
    citizenid,
    fetchBalance,
    fetchTransactions,
    fetchCitizenId
  } = useAccount();
  const { toast } = usePhoneNotification();

  let showSendMoney = $state(false);

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

  const handleSent = (amount: number) => {
    showSendMoney = false;
    toast.show({ type: 'success', app: 'bank', message: `Sent $${amount}.` });
    // The framework's own money functions moved the balance; re-read rather than
    // subtract locally, so this can never drift from what the server actually applied.
    void fetchBalance();
    void fetchTransactions();
  };
</script>

<Screen title="Bank" {onback}>
  <div class="p-4">
    <!-- Card -->
    <CreditCard balance={$bankBalance} citizenid={$citizenid} />

    <Button class="mb-6 w-full" onclick={() => (showSendMoney = true)}>Send Money</Button>

    <!-- Transactions -->
    <h2 class="mb-4 text-lg font-semibold">Recent Transactions</h2>
    <div class="space-y-4">
      {#if !$transactionsLoaded}
        <Skeleton count={3} height="h-14" />
      {:else}
        {#each $transactions as transaction (transaction.id)}
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

{#if showSendMoney}
  <SendMoneyModal
    balance={$bankBalance}
    onsent={handleSent}
    onclose={() => (showSendMoney = false)}
  />
{/if}
