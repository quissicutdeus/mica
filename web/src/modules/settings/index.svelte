<script lang="ts">
    import { is24Hour } from "../../store/time";
    import { isBrowser } from "../../utils/isBrowser";
    import { devToolsVisible, toggleDevTools } from "../../store/dev";
    import Screen from "../../components/Screen.svelte";
    import { MICA_VERSION, MICA_BUILD_INFO } from "@gphone/sdk";
    import { myPhoneNumber, fetchPhoneNumber } from "../../store/account";
    import { onMount } from "svelte";

    let { onback } = $props<{ onback?: () => void }>();

    onMount(() => {
        fetchPhoneNumber();
    });

    const toggleTimeFormat = () => {
        is24Hour.update((v) => !v);
    };
</script>

<Screen title="Settings" {onback}>
    <div class="p-4 space-y-6">
        <!-- General Section -->
        <div>
            <h2
                class="text-sm font-medium text-gray-400 uppercase tracking-wider mb-2 px-2"
            >
                General
            </h2>
            <div class="bg-gray-800 rounded-xl overflow-hidden">
                <button
                    type="button"
                    onclick={toggleTimeFormat}
                    class="w-full flex items-center justify-between p-4 hover:bg-gray-700/50 transition-colors text-left cursor-pointer"
                    aria-label="Toggle 24-hour time"
                >
                    <div class="flex flex-col">
                        <span class="font-medium">24-Hour Time</span>
                        <span class="text-sm text-gray-400"
                            >Use 24-hour format</span
                        >
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

        <!-- About Section -->
        <div>
            <h2
                class="text-sm font-medium text-gray-400 uppercase tracking-wider mb-2 px-2"
            >
                About
            </h2>
            <div
                class="bg-gray-800 rounded-xl overflow-hidden divide-y divide-gray-700/50 text-sm"
            >
                <div class="flex items-center justify-between p-4">
                    <span class="text-gray-300 font-medium">Phone Number</span>
                    <span class="font-mono text-gray-200">{$myPhoneNumber}</span
                    >
                </div>
                <div class="flex items-center justify-between p-4">
                    <span class="text-gray-300 font-medium">Software</span>
                    <span class="font-semibold text-white">gPhone</span>
                </div>
                <div class="flex items-center justify-between p-4">
                    <span class="text-gray-300 font-medium">OS Version</span>
                    <span class="font-mono text-indigo-400"
                        >v{MICA_VERSION}</span
                    >
                </div>
                <div class="flex items-center justify-between p-4">
                    <span class="text-gray-300 font-medium">Build / Commit</span
                    >
                    <span class="font-mono text-xs text-gray-400"
                        >{MICA_BUILD_INFO}</span
                    >
                </div>
            </div>
        </div>

        <!-- Developer Tools Section (Browser Dev Preview Only) -->
        {#if isBrowser()}
            <div>
                <h2
                    class="text-sm font-medium text-gray-400 uppercase tracking-wider mb-2 px-2"
                >
                    Developer
                </h2>
                <div class="bg-gray-800 rounded-xl overflow-hidden">
                    <button
                        type="button"
                        onclick={toggleDevTools}
                        class="w-full flex items-center justify-between p-4 hover:bg-gray-700/50 transition-colors text-left cursor-pointer"
                        aria-label="Toggle Mock DevTools"
                    >
                        <div class="flex flex-col">
                            <span class="font-medium">Mock DevTools</span>
                            <span class="text-sm text-gray-400"
                                >Show browser developer control panel</span
                            >
                        </div>
                        <div
                            class="relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none"
                            class:bg-blue-600={$devToolsVisible}
                            class:bg-gray-600={!$devToolsVisible}
                        >
                            <span
                                class="inline-block h-4 w-4 transform rounded-full bg-white transition-transform"
                                class:translate-x-6={$devToolsVisible}
                                class:translate-x-1={!$devToolsVisible}
                            ></span>
                        </div>
                    </button>
                </div>
            </div>
        {/if}
    </div>
</Screen>
