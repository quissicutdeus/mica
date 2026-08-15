<script lang="ts">
  import { ToggleSwitch, useSystemHardware } from '@gphone/sdk';

  const { cellServiceEnabled, toggleCellService, bluetoothEnabled, toggleBluetooth } =
    useSystemHardware();
</script>

<div class="space-y-6 p-4">
  <div>
    <h2 class="text-on-surface-variant text-body-medium mb-2 px-2 tracking-wider uppercase">
      Cellular Service
    </h2>
    <div class="bg-surface-container overflow-hidden rounded-xl">
      <ToggleSwitch
        label="Cellular Service"
        description="Gate network access and external services"
        checked={$cellServiceEnabled}
        onchange={() => toggleCellService()}
      />
    </div>
    <p class="text-on-surface-variant text-body-small mt-2 px-2">
      Turning off cellular service gates connections to external services and sets signal level to 0
      bars. Local apps (Notes, Camera, Photos, Calculator) operate offline.
    </p>
  </div>

  <div>
    <h2 class="text-on-surface-variant text-body-medium mb-2 px-2 tracking-wider uppercase">
      Bluetooth & Proximity
    </h2>
    <div class="bg-surface-container overflow-hidden rounded-xl">
      <ToggleSwitch
        label="Bluetooth Visibility"
        description="Short-range peer-to-peer discovery"
        checked={$bluetoothEnabled}
        onchange={() => toggleBluetooth()}
      />
    </div>
    <p class="text-on-surface-variant text-body-small mt-2 px-2">
      When Bluetooth is ON, nearby devices can discover your phone for proximity features. Turning
      Bluetooth OFF renders your device invisible to proximity scans and blocks unsolicited contact
      sharing.
    </p>
  </div>
</div>
