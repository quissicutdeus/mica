// SPDX-FileCopyrightText: 2025 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PlayerFacingError } from '../lib/errors';
import { ServiceEndpoint } from '../lib/ServiceEndpoint';
import { BankingBridge } from '../lib/BankingBridge';
import { FrameworkBridge } from '../lib/FrameworkBridge';
import { phoneNumberFrom } from '../lib/netGuard';
import { bankContract } from '@gphone/shared/contracts/bank';
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
const app = new ServiceEndpoint<Transaction, typeof bankContract>('bank', null, {
  contract: bankContract,
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

/**
 * A note is player-supplied and never player-facing — it only ever reaches
 * `Payments.transfer`'s own server log. Its 140-character bound is declared in
 * `shared/contracts/bank.ts` and enforced before this file runs.
 */

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
    // `phoneNumberFrom` still runs: the contract bounds the string, and this is what turns a
    // blank-but-present number into a refusal before it reaches somebody else's lookup.
    const phone = phoneNumberFrom(data.phone);
    if (!phone) {
      throw new PlayerFacingError('A valid recipient phone number is required.');
    }
    const { amount } = data;
    // Trimmed here rather than capped here: the contract's `max` is what a note may be, and a
    // payload that padded its way to the limit with whitespace ends up shorter, never longer.
    const note = data.note?.trim() || undefined;

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
