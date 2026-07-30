<script lang="ts">
    import { onMount } from "svelte";
    import { fly } from "svelte/transition";
    import { formattedTime } from "../store/time";
    import { goHome } from "../store/navigation";
    import { displayCharge, isDead } from "../store/charge";
    import { clampedSignalLevel } from "../store/signal";
    import { adjustVolume } from "../store/sound";
    import { enableDragScroll } from "../utils/dragScroll";
    import LightningWarningIcon from "./icons/LightningWarningIcon.svelte";
    import SignalIcon from "./icons/SignalIcon.svelte";
    import VolumeHud from "./VolumeHud.svelte";

    let { transparent = false, onClose, children } = $props();
    let screenElement = $state<HTMLElement | null>(null);

    onMount(() => {
        if (screenElement) {
            return enableDragScroll(screenElement);
        }
    });
</script>

<!-- Phone Frame -->
<div
    transition:fly={{ y: 1000, duration: 500 }}
    class="relative h-[850px] w-[400px] rounded-[3.5rem] border-[8px] border-gray-900 bg-gray-900 shadow-2xl ring-1 ring-gray-700 transition-colors duration-200"
>
    <!-- Hardware Side Buttons -->
    <!-- Power / Screen Off Button -->
    <button
        class="absolute -right-[13px] top-[180px] h-12 w-[5px] rounded-r-md bg-gray-800 cursor-pointer hover:bg-gray-700 active:bg-gray-600 transition-colors"
        onclick={onClose}
        title="Power / Screen Off"
        aria-label="Power / Screen Off"
    ></button>

    <!-- Volume Buttons -->
    <div class="absolute -right-[13px] top-[250px] flex flex-col gap-2">
        <button
            class="h-10 w-[5px] rounded-r-md bg-gray-800 cursor-pointer hover:bg-gray-700 active:bg-gray-600 transition-colors"
            onclick={() => adjustVolume(0.1)}
            title="Volume Up"
            aria-label="Volume Up"
        ></button>
        <button
            class="h-10 w-[5px] rounded-r-md bg-gray-800 cursor-pointer hover:bg-gray-700 active:bg-gray-600 transition-colors"
            onclick={() => adjustVolume(-0.1)}
            title="Volume Down"
            aria-label="Volume Down"
        ></button>
    </div>

    <!-- Screen -->
    <div
        bind:this={screenElement}
        class="relative h-full w-full overflow-hidden rounded-[3rem] transition-colors duration-200"
        class:bg-gray-900={!transparent && !$isDead}
        class:bg-black={$isDead}
        class:bg-transparent={transparent && !$isDead}
    >
        <!-- On-Screen Volume HUD Overlay -->
        <VolumeHud />

        <!-- Dead Phone Screen Overlay -->
        {#if $isDead}
            <div
                class="absolute inset-0 z-40 flex flex-col items-center justify-center bg-black text-white p-6"
            >
                <!-- Large Blinking Low Battery Icon -->
                <div
                    class="relative flex flex-col items-center justify-center gap-6 animate-pulse"
                >
                    <!-- Battery Outer Container -->
                    <div
                        class="relative w-28 h-14 rounded-2xl border-4 border-red-500/80 p-1.5 flex items-center justify-start shadow-[0_0_20px_rgba(239,68,68,0.3)]"
                    >
                        <!-- Battery Nipple -->
                        <div
                            class="absolute -right-3.5 top-1/2 -translate-y-1/2 w-2.5 h-6 bg-red-500/80 rounded-r-md"
                        ></div>
                        <!-- Low Battery Red Bar (blinking empty state) -->
                        <div class="h-full w-2 bg-red-500 rounded-sm"></div>
                        <!-- Lightning Cable Warning Icon overlay -->
                        <div
                            class="absolute inset-0 flex items-center justify-center"
                        >
                            <LightningWarningIcon />
                        </div>
                    </div>
                    <div class="flex flex-col items-center gap-1.5 text-center">
                        <span
                            class="text-xs font-semibold tracking-wider uppercase text-red-400"
                            >Battery Low</span
                        >
                        <span class="text-[11px] text-gray-400 font-light"
                            >Connect Battery Bank</span
                        >
                    </div>
                </div>
            </div>
        {/if}

        <!-- Status Bar -->
        {#if !transparent && !$isDead}
            <div
                class="absolute top-0 z-20 flex w-full items-center justify-between px-8 pt-3 text-sm font-medium text-white"
            >
                <span>{$formattedTime}</span>
                <div class="flex items-center gap-2">
                    <SignalIcon level={$clampedSignalLevel} />

                    <!-- Battery Status Indicator -->
                    <div class="flex items-center gap-1.5">
                        <span
                            class="text-xs"
                            class:text-red-400={$displayCharge <= 20}
                            >{$displayCharge}%</span
                        >
                        <div
                            class="relative w-5 h-2.5 rounded-[3px] border border-white/80 p-[1px] flex items-center justify-start"
                        >
                            <div
                                class="absolute -right-[3px] top-1/2 -translate-y-1/2 w-[2px] h-1 bg-white/80 rounded-r-[1px]"
                            ></div>
                            <div
                                class="h-full rounded-[1px] transition-all duration-300"
                                class:bg-red-500={$displayCharge <= 20}
                                class:bg-yellow-400={$displayCharge > 20 &&
                                    $displayCharge <= 40}
                                class:bg-white={$displayCharge > 40}
                                style="width: {Math.max(8, $displayCharge)}%;"
                            ></div>
                        </div>
                    </div>
                </div>
            </div>
        {/if}

        <!-- Hole Punch Camera -->
        <div
            class="absolute left-1/2 top-2 z-30 h-6 w-6 -translate-x-1/2 rounded-full bg-black ring-1 ring-gray-800"
        ></div>

        <!-- Content Area -->
        {#if !$isDead}
            <div
                class="h-full"
                class:pt-8={!transparent}
                class:pb-4={!transparent}
            >
                {@render children()}
            </div>
        {/if}

        <!-- Home Indicator Gesture Bar -->
        <button
            class="absolute bottom-0 left-0 z-50 flex h-8 w-full cursor-pointer items-end justify-center pb-2"
            onclick={goHome}
            aria-label="Return to home screen"
        >
            <div
                class="h-1 w-1/3 rounded-full bg-white/80 transition-colors duration-200 hover:bg-white"
            ></div>
        </button>
    </div>
</div>
