<script lang="ts">
    import { soundService } from "../store/sound";

    let {
        name,
        icon: Icon,
        color,
        badge = 0,
        badgeStore,
        onclick,
    }: {
        name: string;
        icon: any;
        color: string;
        badge?: number;
        badgeStore?: any;
        onclick: () => void;
    } = $props();

    let storeBadge = $state(0);

    $effect(() => {
        if (badgeStore && typeof badgeStore.subscribe === "function") {
            const unsubscribe = badgeStore.subscribe((val: number) => {
                storeBadge = val || 0;
            });
            return () => unsubscribe();
        }
    });

    let displayBadge = $derived(badgeStore ? storeBadge : badge);

    const handleClick = () => {
        soundService.play("click");
        onclick();
    };
</script>

<button
    class="flex flex-col items-center gap-2 group relative cursor-pointer"
    onclick={handleClick}
>
    <div
        class="w-14 h-14 rounded-2xl {color} flex items-center justify-center transition-transform group-hover:scale-105 group-active:scale-95 shadow-lg relative cursor-pointer"
    >
        {#if typeof Icon === "string"}
            <img src={Icon} alt={name} class="w-8 h-8 object-contain pointer-events-none" />
        {:else if Icon}
            <Icon />
        {/if}

        {#if displayBadge > 0}
            <!-- Red Unread Notification Badge -->
            <div
                class="absolute -top-1 -right-1 min-w-[20px] h-5 rounded-full bg-rose-500 text-white text-[10px] font-bold flex items-center justify-center px-1 border-2 border-gray-900 shadow-md"
            >
                {displayBadge > 99 ? "99+" : displayBadge}
            </div>
        {/if}
    </div>
    <span class="text-xs font-medium text-gray-300 truncate max-w-[64px]"
        >{name}</span
    >
</button>
