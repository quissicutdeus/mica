<script lang="ts">
  import { EmptyState, Screen, useAppLevels, type AppProps } from '@gphone/sdk';

  // The annotation, not `$props<AppProps>()` — that form only works for an inline object
  // literal and reports "Expected 0 type arguments" for a named type.
  let { onback }: AppProps = $props();

  // Declaring the levels is what claims the Back key. Add a rung per screen, deepest
  // first; with none, Back simply leaves the app. `appId` is what keeps the claim
  // pointed at this app while it sits resident in the background.
  const app = useAppLevels({
    appId: 'snek',
    title: 'Snek',
    onback: () => onback(),
    levels: []
  });
</script>

<Screen title={app.title} onback={app.back}>
  <div class="p-4">
    <EmptyState title="Snek" description="TODO: build the app." />
  </div>
</Screen>
