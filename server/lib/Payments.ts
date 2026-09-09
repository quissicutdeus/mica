// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { FrameworkBridge } from './FrameworkBridge';
import { BankingBridge } from './BankingBridge';

/**
 * Moving money between two players.
 *
 * `FrameworkPlayer` had `getMoney` and `removeMoney` and no `addMoney`, so money could only
 * ever flow *out* of a player. A marketplace could charge a buyer and had no way to pay the
 * seller; a taxi app could charge a fare and not hand it to the driver. Both were blocked on
 * a capability that was absent from the interface, not on anything app code could work around.
 *
 * **Best-effort with a compensating refund, not ACID.** There is no transaction spanning
 * another resource's money system — `qbx_core` and `qb-core` expose two independent calls and
 * nothing that brackets them. So this debits, credits, and refunds the debit if the credit
 * fails, which is the strongest thing available and is not the same as atomic. Said out loud
 * here rather than implied, because a helper called `transfer` invites the assumption.
 *
 * **No client-facing endpoint, deliberately.** Apps call this from their own server actions,
 * so the server decides the amount and the counterparty. A NUI payload naming both is exactly
 * what §2.9 forbids: a request is not proof of intent, and "pay this citizenid this much" is
 * the most obviously forgeable request in the phone.
 */

export type PaymentOutcome =
  | { ok: true; from: string; to: string; amount: number }
  /**
   * Every way this can fail, named.
   *
   * A discriminated union rather than a boolean, for the same reason `PushOutcome` is one: a
   * caller must not be able to treat "the seller was offline" as "the seller was paid". The
   * type is what enforces that, not a comment above the call site.
   *
   * - `invalid_amount`     — not a positive integer.
   * - `same_player`        — from and to are the same citizenid.
   * - `payer_offline`      — the payer is not connected, so nothing can be debited.
   * - `recipient_offline`  — see the note on offline recipients below.
   * - `insufficient_funds` — the payer does not have it.
   * - `debit_failed`       — the framework refused the debit.
   * - `credit_failed`      — the debit succeeded, the credit did not, and the refund worked.
   * - `stranded`           — the credit failed **and** the refund failed. Money has left the
   *                         payer and reached nobody. Logged loudly because it needs a human;
   *                         it is the one outcome no amount of retrying fixes.
   * - `society_unavailable` — `payFromSociety` only: no banking resource on this server can
   *                         hold a society account, or the job has none. Distinct from
   *                         `insufficient_funds`, which says the account exists and is short.
   */
  | {
      ok: false;
      reason:
        | 'invalid_amount'
        | 'same_player'
        | 'payer_offline'
        | 'recipient_offline'
        | 'insufficient_funds'
        | 'debit_failed'
        | 'credit_failed'
        | 'stranded'
        | 'society_unavailable';
    };

export interface TransferRequest {
  /** citizenid paying. */
  from: string;
  /** citizenid being paid. */
  to: string;
  /** Whole currency units, positive. */
  amount: number;
  /** Which balance to move. Defaults to `bank`, since the phone is not a wallet. */
  account?: 'bank' | 'cash';
  /** Why, for the log. Not player-facing. */
  reason: string;
}

/**
 * Debit one player and credit another.
 *
 * **Both players must be online**, and that is a real restriction rather than an oversight.
 * Crediting an offline player would mean writing to the framework's own `players` table, and
 * §10 is explicit that micaOS never touches another resource's tables — the framework owns
 * that money and may cache it in memory for a loaded character. Neither `qbx_core` nor
 * `qb-core` exposes a dependable offline-credit call.
 *
 * So an offline recipient is refused rather than silently dropped. The fix, when a marketplace
 * needs it, is a micaOS-owned pending-payments table flushed on `playerLoaded` — a mailbox,
 * which is legitimate precisely because the money would then be in *our* ledger and not
 * pretended into theirs. That is deliberately not built ahead of the app that needs it.
 */
/**
 * **`balance` through `removeMoney` must never yield (MICA-134).** Everything from the
 * `getMoney` read below to the `removeMoney` debit that follows it has to stay one
 * synchronous span with no `await` in between. This function is `async`, but that span
 * contains none, which is what actually makes it atomic — not any SQL predicate. micaOS
 * owns no money table here, and there is no transaction spanning `qbx_core`/`qb-core`'s own
 * money system to lean on instead (see the file header). The framework's own atomic
 * decrement was considered and rejected for the same reason: frameworks disagree about
 * whether an overdraw refuses or clamps, so the affordability decision has to stay ours,
 * which means it has to happen in a check this function controls rather than one buried in
 * a single framework call. On a single-threaded server, "no yield" is what closes the
 * window a concurrent `transfer` for the same payer would otherwise race through between
 * the check and the debit. `server/__tests__/moneyAtomicity.test.ts` asserts this
 * mechanically — an `await` inserted into that span fails the suite, not just this comment.
 */
export async function transfer(request: TransferRequest): Promise<PaymentOutcome> {
  const { from, to, reason } = request;
  const account = request.account ?? 'bank';
  const amount = request.amount;

  if (!Number.isInteger(amount) || amount <= 0) {
    return { ok: false, reason: 'invalid_amount' };
  }
  // Not merely pointless: a self-transfer through two independent calls can round-trip
  // through a failed credit and leave the player down the amount.
  if (!from || !to || from === to) {
    return { ok: false, reason: 'same_player' };
  }

  const payerSource = FrameworkBridge.getSourceByCitizenId(from);
  if (payerSource === null) return { ok: false, reason: 'payer_offline' };

  const payeeSource = FrameworkBridge.getSourceByCitizenId(to);
  if (payeeSource === null) return { ok: false, reason: 'recipient_offline' };

  const payer = FrameworkBridge.getPlayer(payerSource);
  const payee = FrameworkBridge.getPlayer(payeeSource);
  if (!payer) return { ok: false, reason: 'payer_offline' };
  if (!payee) return { ok: false, reason: 'recipient_offline' };

  // Checked before debiting rather than relying on removeMoney to refuse. Frameworks
  // disagree about whether an overdraw returns false or clamps to zero, and clamping would
  // move less than the credit adds.
  //
  // `Number.isFinite` rather than `balance < amount` alone: the bridge already answers an
  // undeterminable balance with `-Infinity`, but a bare `<` reads as affordable for anything
  // that is not a number at all, so the guard says what it means instead of leaning on the
  // sentinel's sign. A balance nobody can state is not one anybody can spend.
  const balance = payer.getMoney(account);
  if (!Number.isFinite(balance) || balance < amount) {
    return { ok: false, reason: 'insufficient_funds' };
  }

  if (!payer.removeMoney(account, amount)) {
    return { ok: false, reason: 'debit_failed' };
  }

  if (!payee.addMoney(account, amount)) {
    // Compensating refund. The debit already happened, so leaving it is worse than any
    // failure mode this function has.
    const refunded = payer.addMoney(account, amount);
    if (!refunded) {
      console.error(
        `[Payments] STRANDED ${amount} (${account}) from ${from} to ${to} for '${reason}': ` +
          'the credit failed and the refund failed. The payer has been debited and nobody ' +
          'was paid. This needs a human.'
      );
      return { ok: false, reason: 'stranded' };
    }
    console.warn(
      `[Payments] Credit to ${to} failed for '${reason}'; refunded ${amount} to ${from}.`
    );
    return { ok: false, reason: 'credit_failed' };
  }

  console.log(`[Payments] ${from} -> ${to}: ${amount} (${account}) for '${reason}'.`);
  return { ok: true, from, to, amount };
}

export interface SocietyPaymentRequest {
  /** The framework job whose society account pays: 'police'. */
  job: string;
  /** citizenid being paid. */
  to: string;
  /** Whole currency units, positive. */
  amount: number;
  /** Why, for the log. Not player-facing. */
  reason: string;
}

/**
 * Debit a society account and credit a player (MICA-227).
 *
 * The same shape as `transfer` with the payer swapped for a job's account in whichever
 * banking resource holds one — `BankingBridge` decides which, and answers `null`/`false`
 * when none does, which is `society_unavailable` here. The credit lands in the player's
 * `bank` balance, since a society has no cash drawer.
 *
 * **No client endpoint, deliberately — and more so than for `transfer`.** A society account
 * is shared money that a whole job's members have a stake in, and "pay this citizenid this
 * much from the police account" is a payload no boss check makes safe: a NUI request is not
 * proof of intent (§2.9), and a boss's own client can be modified. The Jobs service
 * (MICA-228) exposes the balance *read*, boss-gated, and nothing that names an amount. A
 * server-side script — a payroll, a bonus — calls this from its own code, where the amount
 * and the recipient are the server's decision.
 *
 * **The society read through `removeSocietyMoney` must never yield**, for the reason
 * `transfer` gives at length: the affordability check and the debit it gates are one
 * synchronous span, and an `await` between them reopens a double-spend for two paycheques
 * racing the same account. This function is `async` for the shape of the outcome only and
 * contains no `await` at all.
 */
export async function payFromSociety(request: SocietyPaymentRequest): Promise<PaymentOutcome> {
  const { job, to, reason } = request;
  const amount = request.amount;

  if (!Number.isInteger(amount) || amount <= 0) {
    return { ok: false, reason: 'invalid_amount' };
  }
  if (!job) return { ok: false, reason: 'society_unavailable' };
  if (!to) return { ok: false, reason: 'recipient_offline' };

  const payeeSource = FrameworkBridge.getSourceByCitizenId(to);
  if (payeeSource === null) return { ok: false, reason: 'recipient_offline' };
  const payee = FrameworkBridge.getPlayer(payeeSource);
  if (!payee) return { ok: false, reason: 'recipient_offline' };

  // `null` is "nobody can answer" — no banking resource, or a job with no account. Checked
  // before debiting for the reason `transfer` gives: whether an overdraw refuses or clamps is
  // the banking resource's decision, and the affordability decision has to stay ours.
  const balance = BankingBridge.getSocietyBalance(job);
  if (balance === null) return { ok: false, reason: 'society_unavailable' };
  if (balance < amount) return { ok: false, reason: 'insufficient_funds' };

  if (!BankingBridge.removeSocietyMoney(job, amount)) {
    return { ok: false, reason: 'debit_failed' };
  }

  if (!payee.addMoney('bank', amount)) {
    const refunded = BankingBridge.addSocietyMoney(job, amount);
    if (!refunded) {
      console.error(
        `[Payments] STRANDED ${amount} from society '${job}' to ${to} for '${reason}': the ` +
          'credit failed and the refund failed. The society has been debited and nobody ' +
          'was paid. This needs a human.'
      );
      return { ok: false, reason: 'stranded' };
    }
    console.warn(
      `[Payments] Credit to ${to} failed for '${reason}'; refunded ${amount} to society '${job}'.`
    );
    return { ok: false, reason: 'credit_failed' };
  }

  console.log(`[Payments] society '${job}' -> ${to}: ${amount} (bank) for '${reason}'.`);
  return { ok: true, from: `society:${job}`, to, amount };
}

export interface SocietyChargeRequest {
  /** citizenid paying. */
  from: string;
  /** The job whose society account is credited. */
  job: string;
  /** Whole currency units, positive. */
  amount: number;
  /** Why, for the log. Not player-facing. */
  reason: string;
}

/**
 * Debit a player and credit a society — `payFromSociety` the other way round (MICA-240).
 *
 * The same discipline: affordability is decided here from `getMoney`, the span from that read
 * through `removeMoney` contains no `await`, a credit that fails refunds the player, and a
 * refund that also fails is `stranded` and shouts. `society_unavailable` before any money moves
 * when no banking resource can hold the account, so a server without one refuses cleanly
 * rather than debiting into nothing.
 */
export async function payToSociety(request: SocietyChargeRequest): Promise<PaymentOutcome> {
  const { from, job, reason } = request;
  const amount = request.amount;

  if (!Number.isInteger(amount) || amount <= 0) {
    return { ok: false, reason: 'invalid_amount' };
  }
  if (!from) return { ok: false, reason: 'payer_offline' };
  if (!job) return { ok: false, reason: 'society_unavailable' };

  const payerSource = FrameworkBridge.getSourceByCitizenId(from);
  if (payerSource === null) return { ok: false, reason: 'payer_offline' };
  const payer = FrameworkBridge.getPlayer(payerSource);
  if (!payer) return { ok: false, reason: 'payer_offline' };

  // Asked before the debit so a server with no society account never takes the money.
  if (BankingBridge.getSocietyBalance(job) === null) {
    return { ok: false, reason: 'society_unavailable' };
  }

  const balance = payer.getMoney('bank');
  if (!Number.isFinite(balance) || balance < amount) {
    return { ok: false, reason: 'insufficient_funds' };
  }

  if (!payer.removeMoney('bank', amount)) {
    return { ok: false, reason: 'debit_failed' };
  }

  if (!BankingBridge.addSocietyMoney(job, amount)) {
    const refunded = payer.addMoney('bank', amount);
    if (!refunded) {
      console.error(
        `[Payments] STRANDED ${amount} from ${from} to society '${job}' for '${reason}': the ` +
          'credit failed and the refund failed. The payer has been debited and nobody ' +
          'was paid. This needs a human.'
      );
      return { ok: false, reason: 'stranded' };
    }
    console.warn(
      `[Payments] Credit to society '${job}' failed for '${reason}'; refunded ${amount} to ${from}.`
    );
    return { ok: false, reason: 'credit_failed' };
  }

  console.log(`[Payments] ${from} -> society '${job}': ${amount} (bank) for '${reason}'.`);
  return { ok: true, from, to: `society:${job}`, amount };
}
