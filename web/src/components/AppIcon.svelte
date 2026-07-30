<script lang="ts">
    import { soundService } from "../store/sound";

    let {
        name,
        icon: Icon,
        color,
        badge = 0,
        badgeStore,
        isEditing = false,
        isSystem = true,
        onclick,
        oncontextmenu,
        ondelete,
    }: {
        name: string;
        icon: any;
        color: string;
        badge?: number;
        badgeStore?: any;
        isEditing?: boolean;
        isSystem?: boolean;
        onclick: () => void;
        oncontextmenu?: (e: MouseEvent) => void;
        ondelete?: () => void;
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

    const handleClick = (e: MouseEvent) => {
        if (isEditing) return;
        soundService.play("click");
        onclick();
    };

    const handleContextMenu = (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        oncontextmenu?.(e);
    };

    const handleDeleteClick = (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        soundService.play("click");
        ondelete?.();
    };
</script>

<div
    role="group"
    aria-label="{name} app launcher"
    class="flex flex-col items-center gap-2 group relative cursor-pointer select-none"
    oncontextmenu={handleContextMenu}
>
    <div
        role="button"
        tabindex="0"
        class="w-14 h-14 rounded-2xl {color} flex items-center justify-center transition-transform group-hover:scale-105 group-active:scale-95 shadow-lg relative cursor-pointer"
        class:animate-pulse={isEditing && !isSystem}
        onclick={handleClick}
        onkeydown={(e) => {
            if (!isEditing && (e.key === "Enter" || e.key === " ")) {
                handleClick(e as any);
            }
        }}
    >
        {#if typeof Icon === "string"}
            <img src={Icon} alt={name} class="w-8 h-8 object-contain pointer-events-none" />
        {:else if Icon}
            <Icon />
        {/if}

        {#if isEditing}
            {#if !isSystem}
                <!-- Grey Minus Uninstall Badge for Non-System Apps -->
                <button
                    type="button"
                    class="absolute -top-1.5 -right-1.5 h-5 w-5 rounded-full bg-gray-600 hover:bg-gray-500 text-white font-bold text-xs flex items-center justify-center border-2 border-gray-900 shadow-md cursor-pointer z-20 transition-transform active:scale-90"
                    onclick={handleDeleteClick}
                    title="Uninstall {name}"
                    aria-label="Uninstall {name}"
                >
                    <svg class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M20 12H4" />
                    </svg>
                </button>
            {/if}
        {:else if displayBadge > 0}
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
</div>
