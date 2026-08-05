<script lang="ts">
  import { ToggleSwitch, useClock, useDisplay } from '@gphone/sdk';

  const { is24Hour } = useClock();
  const { displaySize, setDisplaySize, displaySizeDefault, phoneBox, isSizeLimited } = useDisplay();

  const rendered = $derived(
    `${Math.round($phoneBox.width)} × ${Math.round($phoneBox.height)} pixels`
  );
</script>

<div class="space-y-6 p-4">
  <div>
    <h2 class="mb-2 px-2 text-sm font-medium tracking-wider text-gray-400 uppercase">Size</h2>
    <div class="overflow-hidden rounded-xl bg-gray-800">
      <div class="flex flex-col gap-3 p-4">
        <div class="flex items-center justify-between text-sm">
          <span class="font-medium text-gray-200">Phone Size</span>
          <span class="font-mono text-gray-300">{$displaySize}%</span>
        </div>
        <input
          type="range"
          min="0"
          max="100"
          step="1"
          value={$displaySize}
          aria-label="Phone size"
          oninput={(e) => setDisplaySize(Number((e.currentTarget as HTMLInputElement).value))}
          class="h-1.5 w-full cursor-pointer appearance-none rounded-lg bg-gray-900 accent-blue-500"
        />
        <div class="flex items-center justify-between text-xs text-gray-500">
          <span>Smaller</span>
          <span class="font-mono">{rendered}</span>
          <span>Larger</span>
        </div>
        <!-- Say so when the window is deciding instead of the slider. Without this, dragging
             past the point where the phone already fills the screen looks like a dead
             control — which is the normal case on a phone-sized browser window. -->
        {#if $isSizeLimited}
          <p class="text-xs text-amber-400">
            Limited by the size of this window. The phone is scaled down to fit.
          </p>
        {/if}
      </div>
      <div class="border-t border-gray-700 p-4">
        <button
          type="button"
          onclick={() => setDisplaySize(displaySizeDefault)}
          disabled={$displaySize === displaySizeDefault}
          class="w-full cursor-pointer rounded-lg border border-gray-700 bg-gray-900 py-2 text-xs font-semibold text-gray-300 transition-colors hover:bg-gray-700 disabled:cursor-default disabled:opacity-40 disabled:hover:bg-gray-900"
        >
          Reset to Default
        </button>
      </div>
    </div>
    <p class="mt-2 px-2 text-xs text-gray-500">
      The phone always keeps its shape; this changes how large it is drawn on screen.
    </p>
  </div>

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
