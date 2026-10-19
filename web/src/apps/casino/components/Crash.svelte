<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { useAppAction, useLocale } from '@mica/sdk';
  import { cashOut, config, crashOutcome, crashRound, startCrash } from '../store';
  import { crashPayout, formatMultiplier, multiplierAt, stakeProblem } from '../rules';

  const { t } = useLocale();
  const { busy, run } = useAppAction('casino');

  let stake = $state<number | ''>('');
  // The table minimum once the limits arrive, unless the player already typed something.
  $effect(() => {
    if (stake === '' && $config) stake = $config.bet_min;
  });

  /**
   * The curve, redrawn every frame while a round runs. The client never knows where it will
   * crash: it climbs until the `crash` push arrives or a cashout answers `busted`, and either
   * of those clears `crashRound`, which stops the loop.
   */
  let live = $state(100);
  $effect(() => {
    const round = $crashRound;
    if (!round) return;
    const origin = round.started_at + round.offset;
    let frame = 0;
    const tick = () => {
      live = multiplierAt(Date.now() - origin);
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  });

  /** The answer has been asked for; the button stays down until the round is gone. */
  let cashing = $state(false);

  const outcome = $derived($crashOutcome);
  const shown = $derived(
    $crashRound
      ? live
      : outcome?.kind === 'cashed'
        ? outcome.multiplier
        : outcome?.kind === 'busted'
          ? outcome.crash_at
          : 100
  );
  const stakeValue = $derived(stake === '' ? 0 : Number(stake));
  const problem = $derived($config ? stakeProblem(stakeValue, $config) : 'invalid_args');

  const start = async () => {
    const amount = stakeValue;
    await run(() => startCrash(amount), { title: $t('casino.title') });
  };

  const doCashOut = async () => {
    cashing = true;
    const ok = await run(() => cashOut(), { title: $t('casino.title') });
    // A failed request (a timeout, a rate limit) leaves the round live and the button usable;
    // an answer, either way, has already cleared the round.
    if (!ok) cashing = false;
  };

  // A new round re-arms the button.
  $effect(() => {
    if ($crashRound) cashing = false;
  });
</script>

{#if !$config}
  <p class="text-on-surface-variant text-body-medium p-4">{$t('casino.loading')}</p>
{:else}
  <div class="flex min-h-0 flex-1 flex-col gap-4 px-4 pt-4 pb-home-indicator">
    <div class="bg-surface-container flex flex-col items-center gap-2 rounded-box p-6">
      <p
        data-testid="casino-multiplier"
        data-round-id={$crashRound?.round_id}
        class="text-6xl font-mono font-bold {outcome?.kind === 'busted' && !$crashRound
          ? 'text-error'
          : outcome?.kind === 'cashed' && !$crashRound
            ? 'text-green-400'
            : 'text-on-surface'}"
      >
        {formatMultiplier(shown)}
      </p>
      {#if !$crashRound && outcome}
        <p data-testid="casino-crash-result" class="text-body-large text-on-surface text-center">
          {#if outcome.kind === 'cashed'}
            {$t('casino.cashedOut', {
              multiplier: formatMultiplier(outcome.multiplier),
              amount: outcome.payout
            })}
          {:else if outcome.kind === 'busted'}
            {$t('casino.busted', {
              multiplier: formatMultiplier(outcome.crash_at),
              amount: outcome.stake
            })}
          {:else}
            {$t('casino.ended')}
          {/if}
        </p>
      {:else if !$crashRound}
        <p class="text-body-medium text-on-surface-variant text-center">
          {$t('casino.crashHint')}
        </p>
      {/if}
    </div>

    <div class="mt-auto flex flex-col gap-3">
      {#if $crashRound}
        <button
          type="button"
          data-testid="casino-crash-cashout"
          data-round-id={$crashRound.round_id}
          onclick={doCashOut}
          disabled={cashing || $busy}
          class="bg-primary text-on-primary text-label-large disabled:bg-disabled-container disabled:text-disabled-content disabled:cursor-not-allowed rounded-full py-4"
        >
          {cashing
            ? $t('casino.cashingOut')
            : $t('casino.cashOut', { amount: crashPayout($crashRound.stake, live) })}
        </button>
      {:else}
        <label class="text-on-surface-variant text-body-small flex flex-col gap-1">
          {$t('casino.stake')}
          <input
            data-testid="casino-stake"
            type="number"
            min={$config.bet_min}
            max={$config.bet_max}
            step="1"
            placeholder={$t('casino.stakePlaceholder')}
            bind:value={stake}
            class="bg-surface-container text-on-surface text-body-large rounded-box px-3 py-2"
          />
        </label>
        <p class="text-body-small text-on-surface-variant">
          {$t('casino.limits', { min: $config.bet_min, max: $config.bet_max })}
        </p>
        <button
          type="button"
          data-testid="casino-crash-start"
          onclick={start}
          disabled={problem !== null || $busy}
          class="bg-primary text-on-primary text-label-large disabled:bg-disabled-container disabled:text-disabled-content disabled:cursor-not-allowed rounded-full py-4"
        >
          {$t('casino.start')}
        </button>
      {/if}
    </div>
  </div>
{/if}
