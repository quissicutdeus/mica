// SPDX-FileCopyrightText: 2025 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ServiceEndpoint } from '../lib/ServiceEndpoint';
import { BankingBridge } from '../lib/BankingBridge';
import { FrameworkBridge } from '../lib/FrameworkBridge';
import { phoneNumberFrom } from '../lib/netGuard';
import { fields, requirePositiveInt, optionalString } from '../lib/payload';
import { transfer, type PaymentOutcome } from '../lib/Payments';
import { Transaction } from '@gphone/shared/types';

/**
 * Bank: read-only, and backed by the banking resource's own export rather than its
 * database.
 *
 * There is no repository and no `defineService` declaration here on purpose.
 * `player_transactions` belongs to the banking script, not to gPhone — declaring it
 * would generate DDL for someone else's table, and querying it directly would couple
 * the phone to their schema and read data their in-memory cache has already moved
 * past. `BankingBridge` adapts, the same way `FrameworkBridge` does for cores.
 */
const app = new ServiceEndpoint<Transaction>('bank', null, {
  disableGet: true,
  disableCreate: true,
  disableUpdate: true,
  disableDelete: true
});

app.registerEvent('getTransactions', async (source, cbId, data, citizenid) => {
  return BankingBridge.getTransactions(citizenid);
});

const TRANSFER_MAX_CONVAR = 'gphone_bank_transfer_max';
const DEFAULT_TRANSFER_MAX = 50_000;

/** The configured per-transfer ceiling, or the default. Read per call, like every other convar here. */
const transferMax = (): number => {
  const raw = Number.parseInt(GetConvar(TRANSFER_MAX_CONVAR, String(DEFAULT_TRANSFER_MAX)), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TRANSFER_MAX;
};

/** Player-supplied, never player-facing — only ever reaches `Payments.transfer`'s own server log. */
const MAX_NOTE_LENGTH = 140;

/**
 * `Payments.transfer`'s own doc comment says "no client-facing endpoint, deliberately":
 * a raw `{to, amount}` from the client is "the most obviously forgeable request in the
 * phone" when a caller could otherwise let the client name an arbitrary counterparty a
 * player never chose. That warning is about *skipping* the parts below, not about
 * player-to-player payments never being safe to expose — the recipient here is resolved
 * from a phone number server-side (never a raw citizenid), exactly the way `Phone.ts`
 * resolves who a call reaches, and `transfer()` itself re-verifies the real balance
 * against the framework's own money API rather than trusting anything the client claims.
 * `PaymentOutcome`'s reasons cover everything below transferMax(); `exceeds_limit` is the
 * one thing specific to a player-initiated send.
 */
app.registerEvent(
  'sendMoney',
  async (
    source,
    cbId,
    data,
    citizenid
  ): Promise<PaymentOutcome | { ok: false; reason: 'exceeds_limit' }> => {
    const body = fields(data);
    const phone = phoneNumberFrom(body.phone);
    if (!phone) {
      throw new Error('A valid recipient phone number is required.');
    }
    const amount = requirePositiveInt(body.amount, 'amount');
    // Trimmed before the length cap, not after — an untrimmed payload could otherwise pad
    // its way past `MAX_NOTE_LENGTH` with whitespace and still read as the full note.
    const note = optionalString(
      typeof body.note === 'string' ? body.note.trim() : body.note
    )?.slice(0, MAX_NOTE_LENGTH);

    if (amount > transferMax()) {
      return { ok: false, reason: 'exceeds_limit' };
    }

    // Resolved the same way `Phone.ts` resolves who a call reaches — never a client-
    // supplied citizenid. An unknown or currently-offline number reads as the same
    // outcome `Payments.transfer` itself uses for an offline recipient.
    const targetPlayer = FrameworkBridge.getPlayerByPhone(phone);
    if (!targetPlayer?.citizenid) {
      return { ok: false, reason: 'recipient_offline' };
    }

    // Every outcome — success, a compensating refund, or the stranded case — is already
    // logged by `transfer()` itself. A second entry through `AuditLogger` would need a
    // `targetId` naming a specific owned row, which a peer-to-peer payment does not have;
    // forcing one on would document a row that was never written.
    return await transfer({
      from: citizenid,
      to: targetPlayer.citizenid,
      amount,
      account: 'bank',
      reason: note ? `Phone transfer: ${note}` : 'Phone transfer'
    });
  }
);
