import { FrameworkBridge } from './FrameworkBridge';

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
        | 'stranded';
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
 * §10 is explicit that gPhone never touches another resource's tables — the framework owns
 * that money and may cache it in memory for a loaded character. Neither `qbx_core` nor
 * `qb-core` exposes a dependable offline-credit call.
 *
 * So an offline recipient is refused rather than silently dropped. The fix, when a marketplace
 * needs it, is a gPhone-owned pending-payments table flushed on `playerLoaded` — a mailbox,
 * which is legitimate precisely because the money would then be in *our* ledger and not
 * pretended into theirs. That is deliberately not built ahead of the app that needs it.
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
  if (payer.getMoney(account) < amount) {
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
