<script lang="ts">
  import { EmptyState, Screen, useAppRegistry, useNavigation, type AppProps } from '@gphone/sdk';

  /**
   * What opens when an app is installed but has no component to mount.
   *
   * Written for the four invented catalog entries — Blabber, Crypto Tracker, Downtown
   * Taxi, Marketplace — which were manifests with no code behind them. Installing one had
   * nothing to register, so the Store handed the registry a plain `{ name, type }` object in
   * its place, and tapping the icon afterwards landed in `ErrorBoundary` telling the player
   * the app had stopped working. It had not. It was never there.
   *
   * Those entries are gone, so the only way to reach this now is a malformed app directory:
   * `apps/<id>/manifest.ts` present, `index.svelte` missing. The registry lists such an app
   * and has no component for it. That is a developer mistake rather than anything a player
   * can cause, which is why this survives the fictions it was written for — the alternative
   * is `registerApp(app, undefined)`, and the registry mounts whatever it is given.
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
