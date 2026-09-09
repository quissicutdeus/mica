<!--
SPDX-FileCopyrightText: 2025 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import {
    Button,
    EmptyState,
    Screen,
    Skeleton,
    onAppForeground,
    registerMessages,
    useAccount,
    useLocale,
    usePhoneNotification,
    type AppProps
  } from '@mica/sdk';
  import CreditCard from './components/CreditCard.svelte';
  import TransactionItem from './components/TransactionItem.svelte';
  import SendMoneyModal from './components/SendMoneyModal.svelte';
  import en from './locales/en.json';
  import de from './locales/de.json';

  // MICA-215: registered here, at the app's entry point, so every Bank component reads
  // the same `bank.*` namespace whichever screen loads first.
  registerMessages('bank', { en, de });
  const { t } = useLocale();

  let { onback }: AppProps = $props();

  const {
    bankBalance,
    transactions,
    transactionsLoaded,
    historySource,
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
    toast.show({ type: 'success', app: 'bank', message: $t('bank.sent', { amount }) });
    // The framework's own money functions moved the balance; re-read rather than
    // subtract locally, so this can never drift from what the server actually applied.
    void fetchBalance();
    void fetchTransactions();
  };
</script>

<Screen title={$t('bank.title')} {onback}>
  <div class="p-4">
    <!-- Card -->
    <CreditCard balance={$bankBalance} citizenid={$citizenid} />

    <Button class="mb-6 w-full" onclick={() => (showSendMoney = true)}
      >{$t('bank.sendMoney')}</Button
    >

    <!-- Transactions -->
    <h2 class="mb-4 text-lg font-semibold">{$t('bank.recentTransactions')}</h2>
    <div class="space-y-4">
      {#if !$transactionsLoaded}
        <Skeleton count={3} height="h-14" />
      {:else}
        {#each $transactions as transaction (transaction.id)}
          <TransactionItem {transaction} />
        {:else}
          <!-- Three empty lists that mean three things (MICA-241): the account has none, the
               banking resource keeps its statements to itself, or no supported resource is
               running. Only the first is "no transactions"; the others used to look like it. -->
          {#if $historySource.available}
            <EmptyState
              title={$t('bank.noTransactions')}
              description={$t('bank.noTransactionsHint')}
            />
          {:else if $historySource.provider}
            <EmptyState
              title={$t('bank.historyUnavailable')}
              description={$t('bank.historyKeptByScript', { script: $historySource.provider })}
            />
          {:else}
            <EmptyState
              title={$t('bank.historyUnavailable')}
              description={$t('bank.historyNoScript')}
            />
          {/if}
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
