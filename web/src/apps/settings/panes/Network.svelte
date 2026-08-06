<script lang="ts">
  import { ToggleSwitch, useSystemHardware } from '@gphone/sdk';

  const { cellServiceEnabled, toggleCellService, bluetoothEnabled, toggleBluetooth } =
    useSystemHardware();
</script>

<div class="space-y-6 p-4">
  <div>
    <h2 class="mb-2 px-2 text-sm font-medium tracking-wider text-gray-400 uppercase">
      Cellular Service
    </h2>
    <div class="overflow-hidden rounded-xl bg-gray-800">
      <ToggleSwitch
        label="Cellular Service"
        description="Gate network access and external services"
        checked={$cellServiceEnabled}
        onchange={() => toggleCellService()}
      />
    </div>
    <p class="mt-2 px-2 text-xs text-gray-500">
      Turning off cellular service gates connections to external services and sets signal level to 0
      bars. Local apps (Notes, Camera, Photos, Calculator) operate offline.
    </p>
  </div>

  <div>
    <h2 class="mb-2 px-2 text-sm font-medium tracking-wider text-gray-400 uppercase">
      Bluetooth & Proximity
    </h2>
    <div class="overflow-hidden rounded-xl bg-gray-800">
      <ToggleSwitch
        label="Bluetooth Visibility"
        description="Short-range peer-to-peer discovery"
        checked={$bluetoothEnabled}
        onchange={() => toggleBluetooth()}
      />
    </div>
    <p class="mt-2 px-2 text-xs text-gray-500">
      When Bluetooth is ON, nearby devices can discover your phone for proximity features. Turning
      Bluetooth OFF renders your device invisible to proximity scans and blocks unsolicited contact
      sharing.
    </p>
  </div>
</div>
