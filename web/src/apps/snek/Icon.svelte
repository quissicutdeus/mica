<!--
  Gadsden flag pose, after the reference: an open-mouthed head with a forked tongue,
  raised on a rising neck off a coiled loop — not just "a snake shape" but this specific
  silhouette. The tongue is the one deliberate color accent; the rest of the mark is solid
  black regardless of theme, same reasoning as before: the yellow comes from the launcher
  tile (manifest `color: 'bg-yellow-500'`), and the body should read the same in both modes
  rather than fading via `text-on-surface`.
-->
<script lang="ts">
  let { class: className = 'h-8 w-8' }: { class?: string } = $props();
</script>

<svg xmlns="http://www.w3.org/2000/svg" class={className} viewBox="0 0 24 24" fill="none">
  <!-- Open jaw, upper and lower, meeting at the back of the head. -->
  <path d="M3 6 L10 3 L11 7 Z" fill="black" />
  <path d="M3 6 L10 10 L11 7 Z" fill="black" />
  <circle cx="9" cy="5" r="0.6" fill="white" />
  <!-- Forked tongue, flicking out of the open mouth. -->
  <path d="M3 6 0.6 5M3 6 0.8 7.6" stroke="#dc2626" stroke-width="1.1" stroke-linecap="round" />
  <!-- Neck rising off the coil into the head, then the coiled loop itself. -->
  <path
    d="M11 7 C 14 8, 15 11, 14 14 C 13 17, 9 17, 9 19 C 9 21, 13 22, 16 20 C 18 18.5, 18 15.5, 15.5 14"
    stroke="black"
    stroke-width="2.2"
    stroke-linecap="round"
    stroke-linejoin="round"
  />
</svg>
