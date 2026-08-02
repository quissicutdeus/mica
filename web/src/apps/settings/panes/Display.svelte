<script lang="ts">
  import { ToggleSwitch, useClock } from '@gphone/sdk';

  const { is24Hour } = useClock();
</script>

<div class="space-y-6 p-4">
  <div>
    <h2 class="mb-2 px-2 text-sm font-medium tracking-wider text-gray-400 uppercase">Clock</h2>
    <div class="overflow-hidden rounded-xl bg-gray-800">
      <ToggleSwitch
        label="24-Hour Time"
        description="Use 24-hour format"
        checked={$is24Hour}
        onchange={(v) => is24Hour.set(v)}
      />
    </div>
  </div>
</div>
