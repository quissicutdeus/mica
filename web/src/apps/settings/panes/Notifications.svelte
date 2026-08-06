<script lang="ts">
  import { ToggleSwitch, useNotificationSettings } from '@gphone/sdk';
  const { toastsEnabled, notificationSoundEnabled, badgesEnabled } = useNotificationSettings();
</script>

<div class="space-y-6 p-4">
  <div>
    <h2 class="text-on-surface-variant mb-2 px-2 text-xs font-semibold tracking-wider uppercase">
      Banner Toasts & Alerts
    </h2>
    <div
      class="divide-outline-variant bg-surface-container divide-y overflow-hidden rounded-xl text-sm"
    >
      <div class="flex items-center justify-between p-4">
        <div class="flex flex-col pr-4">
          <span class="text-on-surface font-medium">Show Banner Overlay</span>
          <span class="text-on-surface-variant text-xs"
            >Display popup banners when notifications arrive</span
          >
        </div>
        <ToggleSwitch checked={$toastsEnabled} onchange={(val) => toastsEnabled.set(val)} />
      </div>

      <div class="flex items-center justify-between p-4">
        <div class="flex flex-col pr-4">
          <span class="text-on-surface font-medium">Notification Sounds</span>
          <span class="text-on-surface-variant text-xs"
            >Play alert sound on incoming notification</span
          >
        </div>
        <ToggleSwitch
          checked={$notificationSoundEnabled}
          onchange={(val) => notificationSoundEnabled.set(val)}
        />
      </div>
    </div>
  </div>

  <div>
    <h2 class="text-on-surface-variant mb-2 px-2 text-xs font-semibold tracking-wider uppercase">
      App Badges
    </h2>
    <div
      class="divide-outline-variant bg-surface-container divide-y overflow-hidden rounded-xl text-sm"
    >
      <div class="flex items-center justify-between p-4">
        <div class="flex flex-col pr-4">
          <span class="text-on-surface font-medium">App Icon Badges</span>
          <span class="text-on-surface-variant text-xs"
            >Show unread count badges on launcher icons</span
          >
        </div>
        <ToggleSwitch checked={$badgesEnabled} onchange={(val) => badgesEnabled.set(val)} />
      </div>
    </div>
  </div>
</div>
