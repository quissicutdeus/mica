<!--
SPDX-FileCopyrightText: 2025 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import {
    Button,
    DocumentIcon,
    EmptyState,
    HomeIcon,
    Screen,
    Skeleton,
    TabBar,
    onAppForeground,
    registerMessages,
    useAccount,
    useAppEvents,
    useBank,
    useDeepLink,
    useLocale,
    usePhoneNotification,
    type AppProps
  } from '@mica/sdk';
  import CreditCard from './components/CreditCard.svelte';
  import TransactionItem from './components/TransactionItem.svelte';
  import SendMoneyModal from './components/SendMoneyModal.svelte';
  import InvoicesTab from './components/InvoicesTab.svelte';
  import en from './locales/en.json';
  import de from './locales/de.json';

  // MICA-215: registered here, at the app's entry point, so every Bank component reads
  // the same `bank.*` namespace whichever screen loads first.
  registerMessages('bank', { en, de });
  const { t } = useLocale();

  // `tab` is the deep link's prop (`bank?tab=invoices`, what a tapped invoice notification
  // sends). The tab actually showing is `section` below — the prop is consumed once, the
  // state outlives it.
  let { onback, tab }: AppProps & { tab?: string } = $props();

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
  const { invoices, fetchInvoices } = useBank();
  const { toast } = usePhoneNotification();

  let showSendMoney = $state(false);
  let section = $state<'account' | 'invoices'>('account');
  // The badge counts what `InvoicesTab` will actually offer to pay, by the same rule.
  const openCount = $derived($invoices.filter((invoice) => invoice.status === 'active').length);

  // Every time Bank comes to the front, not once per session. Nothing pushes a balance
  // change to the phone, and Bank stays resident, so money spent elsewhere would never
  // show up. Not an `$effect` either: an effect re-runs whenever anything it reads
  // changes, so the first `$state` read added inside this block would turn it into a
  // fetch loop.
  onAppForeground('bank', () => {
    void fetchBalance();
    void fetchTransactions();
    void fetchCitizenId();
    void fetchInvoices();
  });

  // A new bill is pushed while Bank is resident; the push carries only the id, so the
  // list is re-read rather than patched from it (MICA-240).
  useAppEvents('bank').on('invoice', () => {
    void fetchInvoices();
  });

  useDeepLink('bank', () => {
    if (tab !== 'invoices') return false;
    section = 'invoices';
    return true;
  });

  // `TabBar` hands back a bare `string`, so this is the one place it is narrowed.
  const selectSection = (next: string) => {
    if (next === 'account' || next === 'invoices') section = next;
  };

  const refreshCard = () => {
    // The framework's own money functions moved the balance; re-read rather than
    // subtract locally, so this can never drift from what the server actually applied.
    void fetchBalance();
    void fetchTransactions();
  };

  const handleSent = (amount: number) => {
    showSendMoney = false;
    toast.show({ type: 'success', app: 'bank', message: $t('bank.sent', { amount }) });
    refreshCard();
  };
</script>

{#snippet overlay()}
  <TabBar
    aria-label={$t('bank.sections')}
    selected={section}
    onchange={selectSection}
    options={[
      { id: 'account', label: $t('bank.account'), icon: HomeIcon },
      {
        id: 'invoices',
        label: $t('bank.invoices'),
        icon: DocumentIcon,
        badge: openCount
      }
    ]}
  />
{/snippet}

<Screen title={$t('bank.title')} {onback} {overlay}>
  {#if section === 'invoices'}
    <InvoicesTab onpaid={refreshCard} />
  {:else}
    <!-- `pb-20` clears the tab bar and the home indicator: without it the last transaction
         hides underneath the nav. -->
    <div class="p-4 pb-20">
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
  {/if}
</Screen>

{#if showSendMoney}
  <SendMoneyModal
    balance={$bankBalance}
    onsent={handleSent}
    onclose={() => (showSendMoney = false)}
  />
{/if}
