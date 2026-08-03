<script lang="ts">
  import { EmptyState, Screen, useAppRegistry, useNavigation, type AppProps } from '@gphone/sdk';

  /**
   * What opens when a demo catalogue entry is tapped.
   *
   * The four catalogue apps — Chirper, Crypto Tracker, Downtown Taxi, Marketplace — have no
   * code in this repo; they exist so the Store has something to show. Installing one had
   * nothing to register, so the Store handed the registry a plain `{ name, type }` object in
   * its place, and tapping the icon afterwards landed in `ErrorBoundary` telling the player
   * the app had stopped working. It had not. It was never there.
   *
   * A real component, because the registry mounts whatever it is given and the honest answer
   * is a screen rather than a caught exception.
   */
  let { onback }: AppProps = $props();

  const { currentApp } = useNavigation();
  const { registryStore } = useAppRegistry();

  // Asks which app it is standing in for rather than being told. One component is registered
  // against every demo entry, so the name cannot be baked in at registration — and the
  // manifest is already in the registry, which is the thing that mounted this.
  const manifest = $derived($registryStore.find((app) => app.id === $currentApp.id));
  const title = $derived(manifest?.name ?? 'Not installed');
</script>

<Screen {title} {onback}>
  <div class="flex h-full items-center justify-center p-6">
    <EmptyState
      title="Not part of this build"
      description="This is a demo entry in the Store — it has no code in this copy of gPhone. Uninstalling it from the Store will take the icon away."
    />
  </div>
</Screen>
