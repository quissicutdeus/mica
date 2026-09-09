<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import {
    Button,
    EmptyState,
    Skeleton,
    formatCurrency,
    useAppAction,
    useBank,
    useLocale,
    type Invoice,
    type InvoiceActionOutcome
  } from '@mica/sdk';

  const { t, plural } = useLocale();

  interface Props {
    /** A bill was paid and the server moved the money: the caller re-reads the card. */
    onpaid: () => void;
  }

  let { onpaid }: Props = $props();

  const { invoices, invoicesLoaded, payInvoice, declineInvoice } = useBank();
  const { busy, run } = useAppAction('bank');

  // The server lists open invoices only, and the store replaces itself with whatever it
  // says — but a row that is paid or declined is nothing a player can act on, so it is
  // never offered a Pay button whatever the list carried.
  const open = $derived($invoices.filter((invoice) => invoice.status === 'active'));

  // One line per reason, the way `SendMoneyModal` reads `SendMoneyOutcome`. The two "no
  // such open invoice" reasons read the same to a player: whichever it was, the row they
  // tapped is gone, and the list they are about to be handed says so.
  const REFUSAL_MESSAGE: Record<Exclude<InvoiceActionOutcome, { ok: true }>['reason'], string> =
    $derived({
      unknown_invoice: $t('bank.invoiceRefusalNotOpen'),
      not_open: $t('bank.invoiceRefusalNotOpen'),
      expired: $t('bank.invoiceRefusalExpired'),
      invalid_amount: $t('bank.refusalInvalidAmount'),
      same_player: $t('bank.refusalSamePlayer'),
      payer_offline: $t('bank.refusalPayerOffline'),
      recipient_offline: $t('bank.refusalRecipientOffline'),
      insufficient_funds: $t('bank.refusalInsufficientFunds'),
      society_unavailable: $t('bank.invoiceRefusalSocietyUnavailable'),
      debit_failed: $t('bank.refusalDebitFailed'),
      credit_failed: $t('bank.refusalCreditFailed'),
      stranded: $t('bank.refusalStranded')
    });

  /**
   * Whole days until `expires_at`, rounded up: a bill due in 30 hours reads "2 days", one
   * due in 6 hours reads "today". Never negative — the server only lists open invoices, so
   * a row past its date is one the list has not caught up with yet, not one to alarm about.
   */
  const daysLeft = (invoice: Invoice): number =>
    Math.max(0, Math.ceil((invoice.expires_at * 1000 - Date.now()) / 86_400_000));

  const expiresIn = (invoice: Invoice): string => {
    const days = daysLeft(invoice);
    return days === 0 ? $t('bank.expiresToday') : plural('bank.expiresIn', days);
  };

  // A refusal is a normal answer from the server, not a transport failure — but it is the
  // one thing the player needs told, so it is thrown into `run` and reaches them as the
  // error toast with its own reason rather than a generic "that did not work". The store
  // has already followed the reply on the `ok` path, so nothing here touches the list.
  const settle = async (kind: 'pay' | 'decline', invoice: Invoice) => {
    const ok = await run(
      async () => {
        const outcome = await (kind === 'pay' ? payInvoice : declineInvoice)(invoice.id);
        if (!outcome.ok) throw new Error(REFUSAL_MESSAGE[outcome.reason]);
      },
      {
        success:
          kind === 'pay'
            ? $t('bank.invoicePaid', {
                biller: invoice.from_label,
                amount: formatCurrency(invoice.amount)
              })
            : $t('bank.invoiceDeclined', { biller: invoice.from_label })
      }
    );
    if (ok && kind === 'pay') onpaid();
  };
</script>

<!-- `pb-20` clears the tab bar and the home indicator: without it the last row's buttons
     sit under the nav. -->
<div class="flex flex-col gap-4 p-4 pb-20">
  <h2 class="text-lg font-semibold">{$t('bank.openInvoices')}</h2>
  {#if !$invoicesLoaded}
    <Skeleton count={2} height="h-24" />
  {:else}
    {#each open as invoice (invoice.id)}
      <div class="bg-surface-container rounded-box p-4">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="truncate font-medium">{invoice.from_label}</div>
            {#if invoice.memo}
              <div class="text-on-surface-variant text-body-small">{invoice.memo}</div>
            {/if}
            <div class="text-on-surface-variant text-body-small">{expiresIn(invoice)}</div>
          </div>
          <span class="shrink-0 font-medium">
            {$t('bank.invoiceAmount', { amount: formatCurrency(invoice.amount) })}
          </span>
        </div>
        <div class="mt-3 flex gap-3">
          <Button
            class="flex-1"
            variant="secondary"
            disabled={$busy}
            onclick={() => settle('decline', invoice)}>{$t('bank.decline')}</Button
          >
          <Button class="flex-1" disabled={$busy} onclick={() => settle('pay', invoice)}
            >{$t('bank.pay')}</Button
          >
        </div>
      </div>
    {:else}
      <EmptyState title={$t('bank.noInvoices')} description={$t('bank.noInvoicesHint')} />
    {/each}
  {/if}
</div>
