<script lang="ts">
  import {
    Screen,
    Button,
    EmptyState,
    useAppLevels,
    onAppForeground,
    type AppProps
  } from '@gphone/sdk';

  /**
   * The annotation form, not `$props<AppProps>()` — the generic form only accepts an inline
   * object literal and reports "Expected 0 type arguments" for a named type.
   */
  let { onback }: AppProps = $props();

  let detail: string | null = $state(null);
  let taps = $state(0);

  /**
   * The back ladder, and the keyboard claim, in one call.
   *
   * Two things have to happen for back to work inside an app and either can be forgotten:
   * a ladder that closes the deepest open view instead of leaving, and claiming the `back`
   * action, because the shell owns Backspace and pre-empts anything wired only to
   * `<Screen onback>`. `useAppLevels` is both, which is why there is no way to describe the
   * levels and not claim the key.
   *
   * `appId` is required and must match the manifest's `id`. Apps are **resident** — this
   * ladder stays registered while your app sits in the background — so without an owner the
   * dispatcher would hand `back` to whichever app registered last rather than the one on
   * screen. `levels` are given deepest first and are read when back is pressed, not when
   * this is called, so `open` and `close` see current state.
   */
  const app = useAppLevels({
    appId: 'my_addon',
    title: 'My Add-on',
    onback: () => onback(),
    levels: [
      {
        open: () => detail !== null,
        close: () => (detail = null),
        title: () => detail ?? ''
      }
    ]
  });

  /**
   * `onAppForeground`, never `onMount` or a bare `$effect`.
   *
   * An installed app mounts once per session and stays mounted while the player uses other
   * apps, so anything fetched in `onMount` is fetched once and is stale the moment your app
   * goes to the background. The first argument is the app id, for the same residency reason
   * `useAppLevels` needs one.
   */
  onAppForeground('my_addon', () => {
    taps = 0;
  });
</script>

<!--
  `Screen` owns the app viewport and hands its content box a definite height.

  Inside it, fill with `min-h-0 flex-1` — never `h-full`, never a bare `flex-1`. `h-full` is
  a percentage against a box that has already resolved; `flex-1` alone leaves
  `min-height: auto` intact, so the child is sized by its content and refuses to shrink.
  Both fail silently and only once there is enough content to overflow. A box that declares
  `overflow-y-auto` scrolls itself and is exempt.

  The screen is always 400x850. Do not write responsive CSS: breakpoints and viewport units
  (`vh`, `vw`, `dvh`) answer to the browser window, which is not the phone.
-->
<Screen title={app.title} onback={app.back}>
  {#if detail !== null}
    <div class="min-h-0 flex-1 overflow-y-auto p-4">
      <p class="text-body-large text-on-surface">A second level. Back closes it.</p>
    </div>
  {:else}
    <div class="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-4">
      <EmptyState title="Hello from an add-on" description="Built outside the gPhone repo." />
      <p class="text-body-large text-on-surface">Tapped {taps} times</p>
      <Button onclick={() => (taps += 1)}>Tap me</Button>
      <Button variant="secondary" onclick={() => (detail = 'Detail')}>Open a level</Button>
    </div>
  {/if}
</Screen>
