// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A pointer drag an app can use, and the scale measurement underneath it (MICA-294).
 *
 * **Public, and a one-way door.** Both names ship on `@mica/sdk` and on the add-on barrel,
 * through `utils.ts`, for the reason `focusTrap` does: DOM behaviour with no micaOS state
 * behind it, so it bundles into a sandboxed add-on unchanged. Places needed it first and
 * carried a private copy of the measurement (MICA-244), because the shell's own gesture
 * plumbing (`lib/phone/pointerDrag.ts`) is phone-owned and an app may reach only the SDK.
 *
 * **Not a facet, and not in the permission table, on purpose.** Nothing here asks the host
 * anything. It reads the element it is attached to, in whichever document that element lives
 * in — the phone's own for a core app, the add-on's sandboxed frame for one that is not — so
 * there is no call to cross `postMessage`, no member to allow, and nothing a permission could
 * disclose. In a frame the ratio is normally 1: the phone's zoom scales the frame from outside
 * and pointer events inside it already arrive in the frame's own pixels. It is measured
 * rather than assumed so that is true whatever the add-on does with its own transforms.
 */

/**
 * How many on-screen pixels one of the element's own layout pixels is drawn as.
 *
 * The phone is drawn through a `transform: scale()` (Settings > Display > Phone Size), and a
 * drag has one foot on each side of it: `clientX`/`clientY` are on-screen pixels, while
 * `scrollTop`, a CSS transform or an SVG coordinate are in the element's own unscaled ones.
 * Applied 1:1, a phone drawn at 75% moves content three quarters as far as the cursor, so the
 * grab visibly slides out from under the pointer. Divide a client-pixel delta by this.
 *
 * Measured off the element rather than read from a setting, so it is right for any transform
 * in the ancestry and not only the one the phone applies. Zero on either side means nothing is
 * laid out yet — jsdom, or an element not in the document — and answers 1: no correction.
 */
export function measureDragRatio(element: HTMLElement): number {
  const rendered = element.getBoundingClientRect().width;
  const layout = element.offsetWidth;
  return rendered > 0 && layout > 0 ? rendered / layout : 1;
}

/** What `pointerDrag` calls. Travel is always since the press, in the element's own pixels. */
export interface PointerDragOptions {
  /**
   * A press on the element. Return `false` to leave this one alone: it is not tracked, and
   * nothing else below is called for it. Only the primary button of a mouse reaches here.
   */
  onstart?: (event: PointerEvent) => boolean | void;
  /** Every move while pressed, with the travel so far. */
  onmove: (dx: number, dy: number, event: PointerEvent) => void;
  /**
   * Release, cancel (`event.type === 'pointercancel'`), or the pointer lost, with the final
   * travel. Not called for a drag still in progress when the element is destroyed.
   */
  onend?: (dx: number, dy: number, event: PointerEvent) => void;
}

/**
 * A Svelte action: track one pointer from press to release, scale-corrected.
 *
 * ```svelte
 * <div class="touch-none select-none" use:pointerDrag={{ onstart, onmove }}></div>
 * ```
 *
 * It captures the pointer on press, so the drag keeps reporting when the pointer leaves the
 * element, and follows one pointer at a time — a second finger is ignored until the first
 * lifts. Deltas are divided by `measureDragRatio`, taken once at the press.
 *
 * What it deliberately leaves to the caller: which axis, a threshold before a drag counts,
 * momentum, and stopping the page scrolling or selecting text. The last is CSS —
 * `touch-none select-none` on the element — and belongs in the markup, where a reader of the
 * component can see it.
 */
export function pointerDrag(node: HTMLElement, options: PointerDragOptions) {
  let opts = options;
  let active: { id: number; x: number; y: number; ratio: number } | null = null;

  const travel = (event: PointerEvent): [number, number] => {
    if (!active) return [0, 0];
    return [(event.clientX - active.x) / active.ratio, (event.clientY - active.y) / active.ratio];
  };

  const release = (id: number) => {
    try {
      if (node.hasPointerCapture(id)) node.releasePointerCapture(id);
    } catch {
      // jsdom has no pointer capture, and a pointer already gone throws. Neither matters.
    }
  };

  const onpointerdown = (event: PointerEvent) => {
    if (active || event.button !== 0) return;
    if (opts.onstart?.(event) === false) return;
    active = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      ratio: measureDragRatio(node)
    };
    try {
      node.setPointerCapture(event.pointerId);
    } catch {
      // As in `release`: no capture is still a drag, only one that ends at the edge.
    }
  };

  const onpointermove = (event: PointerEvent) => {
    if (!active || event.pointerId !== active.id) return;
    const [dx, dy] = travel(event);
    opts.onmove(dx, dy, event);
  };

  const onpointerend = (event: PointerEvent) => {
    if (!active || event.pointerId !== active.id) return;
    const [dx, dy] = travel(event);
    const { id } = active;
    // Cleared before releasing: `lostpointercapture` can land inside that call, and would
    // otherwise end the same drag a second time.
    active = null;
    release(id);
    opts.onend?.(dx, dy, event);
  };

  node.addEventListener('pointerdown', onpointerdown);
  node.addEventListener('pointermove', onpointermove);
  node.addEventListener('pointerup', onpointerend);
  node.addEventListener('pointercancel', onpointerend);
  node.addEventListener('lostpointercapture', onpointerend);

  return {
    update(next: PointerDragOptions) {
      opts = next;
    },
    destroy() {
      const id = active?.id;
      active = null;
      if (id !== undefined) release(id);
      node.removeEventListener('pointerdown', onpointerdown);
      node.removeEventListener('pointermove', onpointermove);
      node.removeEventListener('pointerup', onpointerend);
      node.removeEventListener('pointercancel', onpointerend);
      node.removeEventListener('lostpointercapture', onpointerend);
    }
  };
}
