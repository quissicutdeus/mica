<script lang="ts">
  import { hashStringToCardNumber } from '../../../utils/cardUtils';
  import { formatCurrency } from '../../../utils/formatters';

  let { balance, citizenid }: { balance: number; citizenid: string } = $props();
</script>

<div
  class="mb-8 rounded-2xl p-6 text-white shadow-lg"
  style="background-image: linear-gradient(to bottom right, var(--color-purple-600), var(--color-blue-600));"
>
  <div class="mb-8 flex items-start justify-between">
    <span class="font-medium text-white/80">Total Balance</span>
    <svg
      xmlns="http://www.w3.org/2000/svg"
      class="h-8 w-8 text-white/50"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
    >
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width="2"
        d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z"
      />
    </svg>
  </div>
  <div class="mb-2 text-3xl font-bold">
    ${formatCurrency(balance)}
  </div>
  <div class="font-mono text-sm tracking-wider text-white/80">
    {hashStringToCardNumber(citizenid)}
  </div>
</div>
