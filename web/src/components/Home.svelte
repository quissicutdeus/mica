<script lang="ts">
    import AppIcon from "./AppIcon.svelte";
    import { appRegistryStore, type AppManifest } from "../store/registry";
    import { toast } from "../store/toast";

    let { openApp } = $props<{ openApp: (id: string) => void }>();
    let isEditing = $state(false);

    const toggleEditMode = (e?: MouseEvent) => {
        if (e) e.preventDefault();
        isEditing = !isEditing;
    };

    const handleUninstall = (app: AppManifest) => {
        try {
            appRegistryStore.unregisterApp(app.id);
            toast.show({
                type: "info",
                message: `${app.name} uninstalled`,
            });
        } catch (err: any) {
            toast.show({
                type: "error",
                message: err.message || "Failed to uninstall app",
            });
        }
    };

    // Auto-exit edit mode if no remaining removable add-on apps exist on the home screen
    $effect(() => {
        if (isEditing) {
            const hasRemovableApps = $appRegistryStore.some(
                (a) => a.isSystem === false,
            );
            if (!hasRemovableApps) {
                isEditing = false;
            }
        }
    });
</script>

<div
    role="region"
    aria-label="Home Screen"
    class="flex h-full flex-col items-center bg-gradient-to-br from-gray-800 to-gray-900 p-4 text-white select-none"
    oncontextmenu={toggleEditMode}
    onclick={(e) => {
        if (
            isEditing &&
            (e.target === e.currentTarget ||
                (e.target as HTMLElement).tagName === "H1")
        ) {
            isEditing = false;
        }
    }}
>
    <h1 class="mb-8 text-4xl font-bold tracking-tight">gPhone</h1>

    <div class="grid grid-cols-4 gap-4 w-full px-4">
        {#each $appRegistryStore as app}
            <AppIcon
                name={app.name}
                color={app.color}
                icon={app.icon}
                badgeStore={app.badgeStore}
                {isEditing}
                isSystem={app.isSystem !== false}
                onclick={() => openApp(app.id)}
                oncontextmenu={() => (isEditing = !isEditing)}
                ondelete={() => handleUninstall(app)}
            />
        {/each}
    </div>
</div>
