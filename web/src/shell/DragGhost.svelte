<script lang="ts">
  import AppIcon from '../sdk/ui/AppIcon.svelte';
  import { iconDragState } from './state/iconDrag';

  let state = $derived($iconDragState);
</script>

{#if state.appId && state.manifest}
  <!-- Follows the pointer in viewport coordinates, not phone-design pixels — a drag ghost
       tracks the finger, it does not scale with the phone like the rest of the UI.
       `pointer-events: none` is required: the ghost must never itself become the element
       `elementsFromPoint` (in `iconDrag.ts`'s `resolveDropAtPoint`) reports under the
       pointer, or every drop would resolve against the ghost instead of the real target. -->
  <div
    class="pointer-events-none fixed z-70 opacity-85"
    style="left: {state.x}px; top: {state.y}px; transform: translate(-50%, -50%);"
  >
    <AppIcon
      name={state.manifest.name}
      color={state.manifest.color}
      icon={state.manifest.icon}
      onclick={() => {}}
    />
  </div>
{/if}
