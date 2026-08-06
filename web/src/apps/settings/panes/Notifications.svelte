<script lang="ts">
  import { ToggleSwitch, useNotificationSettings } from '@gphone/sdk';
  const { toastsEnabled, notificationSoundEnabled, badgesEnabled } = useNotificationSettings();
</script>

<div class="space-y-6 p-4">
  <div>
    <h2 class="mb-2 px-2 text-xs font-semibold tracking-wider text-gray-400 uppercase">
      Banner Toasts & Alerts
    </h2>
    <div class="divide-y divide-gray-700 overflow-hidden rounded-xl bg-gray-800 text-sm">
      <div class="flex items-center justify-between p-4">
        <div class="flex flex-col pr-4">
          <span class="font-medium text-gray-200">Show Banner Overlay</span>
          <span class="text-xs text-gray-400">Display popup banners when notifications arrive</span>
        </div>
        <ToggleSwitch checked={$toastsEnabled} onchange={(val) => toastsEnabled.set(val)} />
      </div>

      <div class="flex items-center justify-between p-4">
        <div class="flex flex-col pr-4">
          <span class="font-medium text-gray-200">Notification Sounds</span>
          <span class="text-xs text-gray-400">Play alert sound on incoming notification</span>
        </div>
        <ToggleSwitch
          checked={$notificationSoundEnabled}
          onchange={(val) => notificationSoundEnabled.set(val)}
        />
      </div>
    </div>
  </div>

  <div>
    <h2 class="mb-2 px-2 text-xs font-semibold tracking-wider text-gray-400 uppercase">
      App Badges
    </h2>
    <div class="divide-y divide-gray-700 overflow-hidden rounded-xl bg-gray-800 text-sm">
      <div class="flex items-center justify-between p-4">
        <div class="flex flex-col pr-4">
          <span class="font-medium text-gray-200">App Icon Badges</span>
          <span class="text-xs text-gray-400">Show unread count badges on launcher icons</span>
        </div>
        <ToggleSwitch checked={$badgesEnabled} onchange={(val) => badgesEnabled.set(val)} />
      </div>
    </div>
  </div>
</div>
