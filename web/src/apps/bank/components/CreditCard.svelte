<script lang="ts">
  import { formatCurrency } from '@gphone/sdk';
  import { hashStringToCardNumber } from '../cardUtils';

  let { balance, citizenid }: { balance: number; citizenid: string } = $props();
</script>

<!-- The gradient is three utility classes, not an inline `style=`. PostCSS never sees a
     markup attribute, so an inline gradient sits outside every CEF-103 transform in
     `postcss.config.js`; and the two custom properties this used to reach for
     (`--color-purple-600`, `--color-blue-600`) were Tailwind v4 theme variables holding
     `oklch()` — Chromium 111 — which is why the card rendered in a dev browser and was
     blank in game. They have been undefined since Tailwind was removed, which made the
     whole declaration invalid at computed-value time in every engine. MICA-85. -->
<div
  class="bg-gradient-to-br from-purple-600 to-blue-600 text-on-surface shadow-elevation-3 mb-8 rounded-lg p-6"
>
  <div class="mb-8 flex items-start justify-between">
    <span class="text-on-surface font-medium">Total Balance</span>
    <svg
      xmlns="http://www.w3.org/2000/svg"
      class="text-on-surface h-8 w-8"
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
  <div class="text-on-surface text-body-medium font-mono tracking-wider">
    {hashStringToCardNumber(citizenid)}
  </div>
</div>
