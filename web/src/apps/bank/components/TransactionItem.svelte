<script lang="ts">
  import { formatCurrency, formatTimestamp } from '@gphone/sdk';
  import type { Transaction } from '@gphone/sdk';

  let { transaction }: { transaction: Transaction } = $props();
</script>

<div class="bg-surface-container flex items-center justify-between rounded-xl p-4">
  <div class="flex items-center">
    <div class="bg-surface-container-high flex h-10 w-10 items-center justify-center rounded-full">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        class="text-on-surface-variant h-5 w-5"
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
      <div class="text-on-surface-variant text-xs">
        {formatTimestamp(transaction.time)}
      </div>
    </div>
  </div>
  <!-- Direction comes from `direction`, never from the sign of `amount`. Banking
       resources store positive magnitudes, so a sign check shows every withdrawal
       as a credit. -->
  <span class={`font-medium ${transaction.direction === 'out' ? 'text-error' : 'text-green-400'}`}>
    {transaction.direction === 'out' ? '-' : '+'}${formatCurrency(transaction.amount)}
  </span>
</div>
