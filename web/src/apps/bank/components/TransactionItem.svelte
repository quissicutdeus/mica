<!--
SPDX-FileCopyrightText: 2026 quissicutdeus

SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { formatCurrency, formatTimestamp } from '@mica/sdk';
  import type { Transaction } from '@mica/sdk';

  let { transaction }: { transaction: Transaction } = $props();
</script>

<div class="bg-surface-container flex items-center justify-between rounded-box p-4">
  <div class="flex items-center">
    <div class="bg-surface-container-high flex h-10 w-10 items-center justify-center rounded-full">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        class="text-on-surface-variant size-icon-md"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
      >
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width="2"
          d="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z"
        />
      </svg>
    </div>
    <div class="ml-3">
      <div class="font-medium">
        {transaction.message || transaction.title || 'Transaction'}
      </div>
      <div class="text-on-surface-variant text-body-small">
        {formatTimestamp(transaction.time)}
      </div>
    </div>
  </div>
  <!-- Direction comes from `direction`, never from the sign of `amount`. Banking
       resources store positive magnitudes, so a sign check shows every withdrawal
       as a credit.

       Money in is `on-surface`, a role, not a green (MICA-411). `text-green-400` was a palette
       literal, so it did not follow the scheme and measured 1.49:1 on the light surface, and no
       single literal passes both. `primary` would pass too but is seeded: a red seed would
       paint money in the same red as money out. The sign carries the direction; `error` marks
       the one worth noticing. -->
  <span class={`font-medium ${transaction.direction === 'out' ? 'text-error' : 'text-on-surface'}`}>
    {transaction.direction === 'out' ? '-' : '+'}${formatCurrency(transaction.amount)}
  </span>
</div>
