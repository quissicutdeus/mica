<script lang="ts">
  import {
    MICA_BUILD_INFO,
    useAccount,
    useAppRegistry,
    usePhoneNotification,
    formatDate
  } from '@gphone/sdk';

  let { ontapbuild } = $props<{ ontapbuild: () => void }>();

  const { myPhoneNumber } = useAccount();
  const { getFirstBootTime } = useAppRegistry();
  const { toast } = usePhoneNotification();

  /**
   * Copy the player's number so it can be pasted into a message.
   *
   * `navigator.clipboard` needs a secure context. NUI is served over
   * `https://cfx-nui-<resource>/` so it qualifies, but CEF can still refuse the
   * permission — hence the execCommand fallback, which is deprecated on the open web
   * and entirely reliable here.
   */
  const copyPhoneNumber = async () => {
    const number = $myPhoneNumber;
    let copied = false;

    try {
      await navigator.clipboard.writeText(number);
      copied = true;
    } catch {
      try {
        const scratch = document.createElement('textarea');
        scratch.value = number;
        // Keep it off-screen and unfocusable so the phone UI does not visibly shift.
        scratch.setAttribute('readonly', '');
        scratch.style.position = 'fixed';
        scratch.style.opacity = '0';
        scratch.style.pointerEvents = 'none';
        document.body.appendChild(scratch);
        scratch.select();
        copied = document.execCommand('copy');
        document.body.removeChild(scratch);
      } catch {
        copied = false;
      }
    }

    toast.show(
      copied
        ? { type: 'success', message: `Copied ${number} to clipboard` }
        : { type: 'error', message: 'Could not copy your number' }
    );
  };
</script>

<div class="p-4">
  <h2 class="mb-2 px-2 text-sm font-medium tracking-wider text-gray-400 uppercase">About</h2>
  <div class="divide-y divide-gray-700 overflow-hidden rounded-xl bg-gray-800 text-sm">
    <button
      type="button"
      onclick={copyPhoneNumber}
      class="flex w-full cursor-pointer items-center justify-between p-4 text-left transition-colors hover:bg-gray-700/40 active:bg-gray-700/60"
      aria-label="Copy phone number to clipboard"
    >
      <span class="font-medium text-gray-300">Phone Number</span>
      <span class="font-mono text-gray-200">{$myPhoneNumber}</span>
    </button>
    <div class="flex items-center justify-between p-4">
      <span class="font-medium text-gray-300">First Boot</span>
      <span class="font-mono text-xs text-gray-300">{formatDate(getFirstBootTime())}</span>
    </div>
    <div class="flex items-center justify-between p-4">
      <span class="font-medium text-gray-300">Software</span>
      <span class="font-semibold text-white">gPhone</span>
    </div>
    <!-- OS Version carries the build info: `v1.0.0 (branch@commit)`. Was a separate
         "Build / Commit" row saying almost the same thing. Ten taps here reveal
         Developer Tools. -->
    <button
      type="button"
      onclick={ontapbuild}
      class="flex w-full cursor-pointer items-center justify-between p-4 text-left transition-colors hover:bg-gray-700/40 active:bg-gray-700/60"
    >
      <span class="font-medium text-gray-300">OS Version</span>
      <span class="font-mono text-indigo-400">{MICA_BUILD_INFO}</span>
    </button>
  </div>
</div>
