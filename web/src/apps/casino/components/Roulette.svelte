<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { onDestroy } from 'svelte';
  import { formatCurrency, useAppAction, useLocale } from '@mica/sdk';
  import { bets, chip, config, lastBets, lastSpin, refusalMessage, spin } from '../store';
  import {
    addChip,
    bestPayout,
    betProblem,
    chipValues,
    colorOf,
    spotKey,
    stakeOf,
    type Bet
  } from '../rules';

  const { t } = useLocale();
  const { busy, run } = useAppAction('casino');

  type Spot = Pick<Bet, 'kind' | 'value'>;
  /** The cell's paint: a pocket's own colour, or the table's grey for an outside bet. */
  type Tone = 'red' | 'black' | 'green' | 'grey';

  /** The numbers as a vertical table: three to a row, 1-2-3 at the top. */
  const ROWS = Array.from({ length: 12 }, (_, r) => [r * 3 + 1, r * 3 + 2, r * 3 + 3]);
  /** The even-money bets, two rows of three as the table lays them out. */
  const EVEN_MONEY = ['low', 'even', 'red', 'black', 'odd', 'high'] as const;

  const chips = $derived($config ? chipValues($config) : []);
  const placed = $derived(new Map($bets.map((b) => [spotKey(b), b.amount])));
  const stake = $derived(stakeOf($bets));
  const best = $derived(bestPayout($bets));
  const problem = $derived($config ? betProblem($bets, $config) : 'no_bets');

  /** True for the short reveal between the server's answer and showing it. */
  let revealing = $state(false);
  let revealTimer: ReturnType<typeof setTimeout> | undefined;
  onDestroy(() => clearTimeout(revealTimer));

  /** Why the last tap placed nothing — a greyed-out board says nothing on its own. */
  let refusedTap = $state('');

  const place = (spot: Spot) => {
    if (!$config || revealing) return;
    const next = addChip($bets, spot, $chip, $config);
    if (next === $bets) {
      refusedTap = refusalMessage(stake + $chip > $config.bet_max ? 'above_max' : 'too_many_bets');
      return;
    }
    refusedTap = '';
    bets.set(next);
  };

  const doSpin = async () => {
    revealing = true;
    const ok = await run(() => spin(), { title: $t('casino.title') });
    if (!ok) {
      revealing = false;
      return;
    }
    clearTimeout(revealTimer);
    revealTimer = setTimeout(() => (revealing = false), 900);
  };

  const result = $derived($lastSpin);
  const net = $derived(result ? result.payout - result.stake : 0);
</script>

{#if !$config}
  <p class="text-on-surface-variant text-body-medium p-4">{$t('casino.loading')}</p>
{:else}
  <div class="flex min-h-0 flex-1 flex-col">
    <div class="min-h-0 flex-1 overflow-y-auto px-4 pt-3 pb-2">
      <div
        data-testid="casino-board"
        role="group"
        aria-label={$t('casino.board')}
        class="grid grid-cols-3 gap-1"
      >
        {#snippet cell(spot: Spot, label: string, tone: Tone)}
          {@const amount = placed.get(spotKey(spot))}
          <button
            type="button"
            data-testid="casino-bet-{spotKey(spot)}"
            aria-label={label}
            onclick={() => place(spot)}
            disabled={$busy || revealing}
            class="text-label-large relative flex h-9 cursor-pointer items-center justify-center rounded-chip text-white disabled:cursor-not-allowed {tone ===
            'red'
              ? 'bg-red-700'
              : tone === 'black'
                ? 'bg-gray-950'
                : tone === 'green'
                  ? 'bg-green-600 col-span-3'
                  : 'bg-gray-700'}"
          >
            {label}
            {#if amount}
              <span
                class="bg-yellow-400 text-label-small absolute right-1 top-1 rounded-full px-1.5 text-gray-900"
              >
                {amount}
              </span>
            {/if}
          </button>
        {/snippet}

        {@render cell({ kind: 'straight', value: 0 }, '0', 'green')}
        {#each ROWS as row (row[0])}
          {#each row as n (n)}
            {@render cell({ kind: 'straight', value: n }, String(n), colorOf(n))}
          {/each}
        {/each}
        {#each [1, 2, 3] as c (c)}
          {@render cell({ kind: 'column', value: c }, $t('casino.column'), 'grey')}
        {/each}
        {#each [1, 2, 3] as d (d)}
          {@render cell({ kind: 'dozen', value: d }, $t(`casino.dozen.${d}`), 'grey')}
        {/each}
        {#each EVEN_MONEY as kind (kind)}
          {@render cell(
            { kind },
            $t(`casino.${kind}`),
            kind === 'red' || kind === 'black' ? kind : 'grey'
          )}
        {/each}
      </div>
    </div>

    <div class="border-outline-variant flex flex-col gap-2 border-t px-4 pt-3 pb-home-indicator">
      {#if revealing}
        <p class="text-on-surface-variant text-title-medium animate-pulse text-center">
          {$t('casino.spinning')}
        </p>
      {:else if result}
        <div data-testid="casino-result" class="flex items-center justify-center gap-3">
          <span
            class="text-title-large flex h-10 w-10 items-center justify-center rounded-full text-white {result.color ===
            'red'
              ? 'bg-red-700'
              : result.color === 'black'
                ? 'bg-gray-950'
                : 'bg-green-600'}"
          >
            {result.number}
          </span>
          <span
            class="text-title-medium {net > 0
              ? 'text-on-surface'
              : net < 0
                ? 'text-error'
                : 'text-on-surface'}"
          >
            {net > 0
              ? $t('casino.won', { amount: formatCurrency(net) })
              : net < 0
                ? $t('casino.lost', { amount: formatCurrency(-net) })
                : $t('casino.brokeEven')}
          </span>
        </div>
      {/if}

      <div role="group" aria-label={$t('casino.chips')} class="flex gap-2">
        {#each chips as value (value)}
          <button
            type="button"
            data-testid="casino-chip"
            data-value={value}
            aria-pressed={$chip === value}
            onclick={() => chip.set(value)}
            class="text-label-large flex-1 cursor-pointer rounded-full border-2 py-1.5 {$chip ===
            value
              ? 'border-yellow-400 bg-surface-container-high text-on-surface'
              : 'border-outline-variant text-on-surface-variant'}"
          >
            <!-- A chip is a denomination, not a sum: whole dollars and no grouping, because six
                 of them share one row and `formatCurrency`'s `$25,000.00` does not fit one
                 (MICA-415). Every total and result on this screen goes through it. -->
            {$t('casino.chipValue', { amount: value })}
          </button>
        {/each}
      </div>

      <div class="text-body-small text-on-surface-variant flex justify-between">
        <span
          >{$t('casino.staked', {
            stake: formatCurrency(stake),
            max: formatCurrency($config.bet_max)
          })}</span
        >
        {#if refusedTap && stake > 0}
          <span class="text-error">{refusedTap}</span>
        {:else if stake > 0}
          <span>{$t('casino.bestReturn', { amount: formatCurrency(best) })}</span>
        {/if}
      </div>

      <div class="flex gap-2">
        {#if stake > 0}
          <button
            type="button"
            onclick={() => bets.set([])}
            disabled={$busy || revealing}
            class="bg-surface-container-high text-on-surface text-label-large disabled:cursor-not-allowed rounded-full px-4 py-3"
          >
            {$t('casino.clear')}
          </button>
        {:else if $lastBets.length > 0}
          <button
            type="button"
            onclick={() => bets.set($lastBets)}
            disabled={$busy || revealing}
            class="bg-surface-container-high text-on-surface text-label-large disabled:cursor-not-allowed rounded-full px-4 py-3"
          >
            {$t('casino.rebet')}
          </button>
        {/if}
        <button
          type="button"
          data-testid="casino-spin"
          onclick={doSpin}
          disabled={problem !== null || $busy || revealing}
          class="bg-primary text-on-primary text-label-large disabled:bg-disabled-container disabled:text-disabled-content disabled:cursor-not-allowed flex-1 rounded-full py-3"
        >
          {$t('casino.spin')}
        </button>
      </div>
    </div>
  </div>
{/if}
