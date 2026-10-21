# Gating a parent control from inside a primitive

MICA-405. `MediaThumb` sits inside the caller's button at ten of nineteen call
sites, so its streamer-mode reveal cannot be a control of its own: any
interactive descendant of a button is invalid ARIA, `role="button"` included. It
now finds its control with `closest()` and gates that control's own activation
instead, with no prop and no call-site edit.

What was not obvious:

- **Capture, not bubble.** A bubble-phase listener added on the host button lost
  to the caller's Svelte `onclick` in the unit suite; only
  `addEventListener('click', fn, true)` on the host runs before both the host's
  own listeners and Svelte's delegated root. Proven by flipping the flag: five
  tests fail.
- **Never gate keydown on a native button.** Enter and Space already become a
  click there, and Space's click fires on keyup, after a keydown-triggered
  reveal has torn the gate down, so the original would open. Gate keys only on a
  `role="button"` that acts in its own `onkeydown` (Messages' location card).
- **Say it with `aria-describedby`, not the name.** The host keeps its own
  `aria-label`; the primitive appends an id pointing at a `hidden` span and
  removes only its own token. The painted chip is `aria-hidden` generated
  content, per [[axe-visible-text-is-text-nodes]].
- **jsdom does not turn Enter into a click.** The unit tests dispatch the
  keydown and then the `detail: 0` click a browser would; no `user-event` here.

**Why:** a filter in a primitive that reaches up into the caller's DOM is
unusual, and the next agent will want to "simplify" it back to a child control.

**How to apply:** any `sdk/ui` primitive that needs its own interaction while
usually drawn inside a caller's control: gate the control from capture, keep
props unchanged, and name the e2e specs that queried the old inner control.
