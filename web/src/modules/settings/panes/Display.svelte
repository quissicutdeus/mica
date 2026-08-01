<script lang="ts">
  import { useSystemHardware } from '@gphone/sdk';

  const { is24Hour } = useSystemHardware();

  const toggleTimeFormat = () => is24Hour.update((v) => !v);
</script>

<div class="space-y-6 p-4">
  <div>
    <h2 class="mb-2 px-2 text-sm font-medium tracking-wider text-gray-400 uppercase">Clock</h2>
    <div class="overflow-hidden rounded-xl bg-gray-800">
      <button
        type="button"
        onclick={toggleTimeFormat}
        class="flex w-full cursor-pointer items-center justify-between p-4 text-left transition-colors hover:bg-gray-700"
        aria-label="Toggle 24-hour time"
      >
        <div class="flex flex-col">
          <span class="font-medium">24-Hour Time</span>
          <span class="text-sm text-gray-400">Use 24-hour format</span>
        </div>
        <div
          class="relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none"
          class:bg-blue-600={$is24Hour}
          class:bg-gray-600={!$is24Hour}
        >
          <span
            class="inline-block h-4 w-4 transform rounded-full bg-white transition-transform"
            class:translate-x-6={$is24Hour}
            class:translate-x-1={!$is24Hour}
          ></span>
        </div>
      </button>
    </div>
  </div>
</div>
