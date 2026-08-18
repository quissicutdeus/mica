<script lang="ts">
  import AppIcon from '../sdk/ui/AppIcon.svelte';
  import { iconDragState } from './state/iconDrag';
  import { PHONE_WIDTH } from './state/display';

  let state = $derived($iconDragState);

  /**
   * `iconDragState.x/y` are real viewport pixels — `resolveDropAtPoint` (`iconDrag.ts`)
   * needs those for `elementsFromPoint`, which is always viewport-relative. But this ghost
   * renders inside `Shell.svelte`'s `transform: scale($phoneScale)` wrapper, and a transform
   * on an ancestor makes *that* ancestor the containing block for `position: fixed`
   * descendants instead of the real viewport — so a raw viewport pixel used as `left`/`top`
   * here lands wrong, drifting further from the actual cursor the more the phone is zoomed
   * down (visibly toward the bottom-right at any zoom below 1). Converting through the
   * `[data-testid="phone-frame"]` element's own measured rect — rather than importing
   * `phoneScale`/`phoneBox` and reasoning about layout math — sidesteps having to track
   * every offset (bezel border, flex centering) that separates it from the transformed
   * wrapper: whatever the real screen position and size of that element are, dividing by
   * `PHONE_WIDTH` recovers the effective scale directly from what's actually on screen.
   */
  function toLocalPoint(clientX: number, clientY: number): { x: number; y: number } {
    if (typeof document === 'undefined') return { x: clientX, y: clientY };
    const frame = document.querySelector('[data-testid="phone-frame"]');
    if (!frame) return { x: clientX, y: clientY };
    const rect = frame.getBoundingClientRect();
    if (rect.width === 0) return { x: clientX, y: clientY };
    const scale = rect.width / PHONE_WIDTH;
    return { x: (clientX - rect.left) / scale, y: (clientY - rect.top) / scale };
  }

  let point = $derived(toLocalPoint(state.x, state.y));
</script>

{#if state.appId && state.manifest}
  <!-- pointer-events: none is required: the ghost must never itself become the element
       `elementsFromPoint` (in `iconDrag.ts`'s `resolveDropAtPoint`) reports under the
       pointer, or every drop would resolve against the ghost instead of the real target. -->
  <div
    class="pointer-events-none fixed z-70 opacity-85"
    style="left: {point.x}px; top: {point.y}px; transform: translate(-50%, -50%);"
  >
    <AppIcon
      name={state.manifest.name}
      color={state.manifest.color}
      icon={state.manifest.icon}
      onclick={() => {}}
    />
  </div>
{/if}
