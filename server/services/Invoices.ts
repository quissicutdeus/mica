// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineService } from '../lib/defineService';
import { InvoiceRepository } from '../repositories/InvoiceRepository';
import { invoicesContract } from '@mica/shared/contracts/invoices';
import { buildDeepLink } from '@mica/shared/deepLink';
import type { Invoice, InvoiceActionOutcome } from '@mica/shared/types';
import { appEventChannel } from '../lib/appEvents';
import { payToSociety, transfer, type PaymentOutcome } from '../lib/Payments';

/**
 * Invoices (MICA-240): a resource bills a player, and the player pays or declines from the
 * Bank app.
 *
 * Mechanic, lawyer, doctor and shop scripts bill players through the phone on every other
 * phone; micaOS's Bank did transfers only, and `Payments` deliberately has no client-facing
 * endpoint, so a job script had no way to present a bill a player could accept. This is that
 * way, and it keeps `Payments`' rule intact: the **server** decides the amount and the
 * counterparty when the invoice is created through the `SendInvoice` export, and the only
 * thing a client ever says is "pay this one of mine" or "decline it".
 *
 * **Nothing here is client-creatable.** `write: 'server'` and every generic action off means
 * this declaration registers no CRUD event at all; the three actions below are the whole
 * reachable surface, each scoped by the caller's own citizenid, and `clientWritable: false`
 * on every column says so a second time for the day a generic action is switched on.
 *
 * Money moves through `Payments` — `payToSociety` for a job's account, `transfer` for a
 * character — with their refund paths, and the row is **claimed before the money moves** and
 * reopened if it does not (`InvoiceRepository.claim`), which is what makes two taps on Pay
 * charge once. A payee who is offline is `recipient_offline` and the invoice stays open;
 * crediting an offline character would mean writing the framework's own tables (§10).
 */
export const invoices = defineService<Invoice, typeof invoicesContract>({
  id: 'invoices',
  app: 'bank',
  contract: invoicesContract,
  access: { read: 'owner', write: 'server' },
  statuses: ['active', 'paid', 'declined', 'expired', 'deleted'],
  schema: {
    from_label: { type: 'string', length: 64, notNull: true, clientWritable: false },
    amount: { type: 'int', notNull: true, clientWritable: false },
    memo: { type: 'string', length: 140, clientWritable: false },
    society: { type: 'string', length: 64, clientWritable: false },
    payee: { type: 'string', length: 50, clientWritable: false },
    resource: { type: 'string', length: 64, notNull: true, clientWritable: false },
    // Epoch seconds rather than `timestamp`, so `expires_at <= ?` compares against a number
    // this process produced and a nullable `paid_at` needs no per-server default rule.
    expires_at: { type: 'int', notNull: true, clientWritable: false },
    paid_at: { type: 'int', clientWritable: false }
  },
  indexes: [
    { name: 'citizenid_status_expires', columns: ['citizenid', 'status', 'expires_at'] },
    // The sweep's own key: every open row past its date, without a citizen in the predicate.
    { name: 'status_expires', columns: ['status', 'expires_at'] }
  ],
  options: { disableGet: true, disableCreate: true, disableUpdate: true, disableDelete: true },
  repositoryFactory: (resolved) => new InvoiceRepository(resolved)
});

const repo = invoices.repo as InvoiceRepository;

/* ------------------------------------------------------------------ expiry */

const EXPIRY_CONVAR = 'mica_invoice_expiry_days';
const DEFAULT_EXPIRY_DAYS = 7;
const DAY_SECONDS = 86_400;
const SWEEP_MS = 60 * 60 * 1000;

/** Read per call, like every other convar here: an owner can change it without a restart. */
export const expiryDays = (): number => {
  const raw = typeof GetConvarInt === 'function' ? GetConvarInt(EXPIRY_CONVAR, 0) : 0;
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_EXPIRY_DAYS;
};

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/**
 * Mark every open invoice past its date as expired. Hourly, and once at start, so a row that
 * lapsed while the server was down is settled before anyone can see it. `findOpen` excludes a
 * lapsed row on its own, so the sweep is bookkeeping rather than a gate — `pay` and `decline`
 * check the date themselves.
 */
export const expireDueInvoices = async (): Promise<void> => {
  try {
    await repo.expireDue(nowSeconds());
  } catch (error) {
    console.error('[Invoices] the expiry sweep failed; it runs again next hour.', error);
  }
};

if (typeof setInterval === 'function') setInterval(() => void expireDueInvoices(), SWEEP_MS);

on('onResourceStart', (resource: string) => {
  if (resource === GetCurrentResourceName()) void expireDueInvoices();
});

/* --------------------------------------------------------------- callbacks */

export interface InvoiceCallbacks {
  onPaid?: (invoice: Invoice) => unknown;
  onDeclined?: (invoice: Invoice) => unknown;
}

/**
 * What a biller asked to be told, keyed by invoice id and attributed to the resource that
 * registered it (MICA-240).
 *
 * In memory only, deliberately: a callback is a function ref into another resource, and a ref
 * does not survive either resource restarting. A biller that needs to know about a payment
 * made after its own restart reads its own records — the invoice row says `paid` and when.
 * Released on `onResourceStop` so a stopped script's refs are never called.
 */
const callbacks = new Map<number, { owner: string } & InvoiceCallbacks>();

export const rememberCallbacks = (id: number, owner: string, cbs: InvoiceCallbacks): void => {
  if (!cbs.onPaid && !cbs.onDeclined) return;
  callbacks.set(id, { owner, ...cbs });
};

/** Test seam. */
export const __resetInvoiceCallbacks = (): void => {
  callbacks.clear();
};

/** Tell the biller, and never let its handler's failure reach the player's request. */
const notifyBiller = (invoice: Invoice, event: 'onPaid' | 'onDeclined'): void => {
  const entry = callbacks.get(invoice.id);
  callbacks.delete(invoice.id);
  const handler = entry?.[event];
  if (!handler) return;
  try {
    Promise.resolve(handler(invoice)).catch((error: unknown) => {
      console.error(
        `[Invoices] ${entry?.owner}'s ${event} for invoice ${invoice.id} rejected:`,
        error
      );
    });
  } catch (error) {
    console.error(`[Invoices] ${entry?.owner}'s ${event} for invoice ${invoice.id} threw:`, error);
  }
};

on('onResourceStop', (resource: string) => {
  let dropped = 0;
  for (const [id, entry] of callbacks) {
    if (entry.owner === resource) {
      callbacks.delete(id);
      dropped += 1;
    }
  }
  if (dropped > 0)
    console.log(`[mica] released ${dropped} invoice callback(s) held by ${resource}.`);
});

/* ---------------------------------------------------------------- creation */

export interface NewInvoice {
  citizenid: string;
  from_label: string;
  amount: number;
  memo: string | null;
  society: string | null;
  payee: string | null;
  resource: string;
}

/**
 * Write an open invoice and tell the player, online or not.
 *
 * The push persists a notification row whether or not the player is connected, which is
 * what "works when the player is offline" means here: the invoice is in the table, the
 * notification is in the shade, and both are there when they next open the phone.
 * `publicApi.ts` validates; this only writes.
 */
export const createInvoice = async (
  input: NewInvoice,
  cbs: InvoiceCallbacks = {}
): Promise<number> => {
  const expires_at = nowSeconds() + expiryDays() * DAY_SECONDS;
  const id = await repo.create({ ...input, expires_at, paid_at: null } as Partial<Invoice>);
  rememberCallbacks(id, input.resource, cbs);

  const outcome = appEventChannel('bank').push(
    input.citizenid,
    'invoice',
    { id },
    {
      notify: {
        type: 'info',
        title: `Invoice from ${input.from_label}`,
        message: input.memo ? `$${input.amount} — ${input.memo}` : `$${input.amount}`
      },
      kind: 'invoice',
      title: `Invoice from ${input.from_label}`,
      deepLink: buildDeepLink('bank', { tab: 'invoices' })
    }
  );
  if (!outcome.delivered && outcome.reason !== 'offline') {
    console.error(
      `[Invoices] could not push invoice ${id} to ${input.citizenid}: ${outcome.reason}`
    );
  }
  return id;
};

/* ----------------------------------------------------------------- actions */

const openFor = async (citizenid: string): Promise<Invoice[]> =>
  await repo.findOpen(citizenid, nowSeconds());

invoices.app.registerEvent('getOpen', async (source, cbId, data, citizenid) => {
  return await openFor(citizenid);
});

/**
 * The one row this request may act on: the caller's, by id. A miss is `unknown_invoice`
 * whether the row is somebody else's or nobody's — the same answer, so an id cannot be used
 * to probe for other players' invoices.
 */
const ownOpenInvoice = async (
  id: number,
  citizenid: string
): Promise<{ invoice: Invoice } | { refusal: InvoiceActionOutcome }> => {
  const invoice = await repo.findById(id, citizenid);
  if (!invoice) return { refusal: { ok: false, reason: 'unknown_invoice' } };
  if (invoice.status !== 'active') return { refusal: { ok: false, reason: 'not_open' } };
  if (Number(invoice.expires_at) <= nowSeconds()) {
    // Settle it now rather than wait for the sweep, so the list and the answer agree.
    await repo.expireDue(nowSeconds());
    return { refusal: { ok: false, reason: 'expired' } };
  }
  return { invoice };
};

/** Route the money to whichever side the invoice names. */
const settle = async (invoice: Invoice, payer: string): Promise<PaymentOutcome> => {
  const reason = `Invoice ${invoice.id} from ${invoice.from_label}`;
  const amount = Number(invoice.amount);
  if (invoice.society) {
    return await payToSociety({ from: payer, job: invoice.society, amount, reason });
  }
  if (invoice.payee) {
    return await transfer({ from: payer, to: invoice.payee, amount, account: 'bank', reason });
  }
  // Refused at creation, so unreachable; answered rather than assumed.
  return { ok: false, reason: 'recipient_offline' };
};

invoices.app.registerEvent('pay', async (source, cbId, data, citizenid) => {
  const found = await ownOpenInvoice(data.id, citizenid);
  if ('refusal' in found) return found.refusal;
  const { invoice } = found;

  // Claim first. The statement's own `status = 'active'` predicate is what makes a second
  // tap — or a second client — find nothing to claim, before any money has moved.
  if (!(await repo.claim(invoice.id, citizenid, 'paid', null))) {
    return { ok: false, reason: 'not_open' } satisfies InvoiceActionOutcome;
  }

  const outcome = await settle(invoice, citizenid);
  if (!outcome.ok) {
    await repo.reopen(invoice.id, citizenid);
    return { ok: false, reason: outcome.reason } satisfies InvoiceActionOutcome;
  }

  // The claim above moved the row out of `active`; the timestamp is what tells `reopen`
  // the payment landed, so it is written only now that it has.
  const paidAt = nowSeconds();
  await stampPaidAt(invoice.id, citizenid, paidAt);
  notifyBiller({ ...invoice, status: 'paid', paid_at: paidAt }, 'onPaid');
  return { ok: true, invoices: await openFor(citizenid) } satisfies InvoiceActionOutcome;
});

const stampPaidAt = async (id: number, citizenid: string, paidAt: number): Promise<void> => {
  try {
    await repo.stampPaid(id, citizenid, paidAt);
  } catch (error) {
    // The money moved and the row is `paid`; a missing timestamp is worth a line, not a refund.
    console.error(`[Invoices] could not stamp paid_at on invoice ${id}:`, error);
  }
};

invoices.app.registerEvent('decline', async (source, cbId, data, citizenid) => {
  const found = await ownOpenInvoice(data.id, citizenid);
  if ('refusal' in found) return found.refusal;
  const { invoice } = found;

  if (!(await repo.claim(invoice.id, citizenid, 'declined', null))) {
    return { ok: false, reason: 'not_open' } satisfies InvoiceActionOutcome;
  }
  notifyBiller({ ...invoice, status: 'declined' }, 'onDeclined');
  return { ok: true, invoices: await openFor(citizenid) } satisfies InvoiceActionOutcome;
});
