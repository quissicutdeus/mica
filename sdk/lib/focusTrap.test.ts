// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { focusTrap } from './focusTrap';

/**
 * MICA-66.
 *
 * **What these assertions are worth, and what they are not.** jsdom does not implement
 * sequential focus navigation: pressing Tab in jsdom moves focus nowhere on its own. That
 * cuts both ways here. It means a test cannot prove the browser's *default* Tab would have
 * escaped the dialog — the escape is exactly the thing jsdom will not simulate — so
 * `preventDefault` is asserted directly instead, because calling it is the whole of how
 * the trap stops the default from happening.
 *
 * It also means the wrapping assertions are meaningful rather than accidental: the only
 * thing that can move focus in these cases is the trap's own handler, so
 * `document.activeElement` after a synthetic Tab is a reading of this module's logic and
 * nothing else's.
 *
 * What is *not* covered: real tab order (jsdom has none), visibility filtering by layout
 * (jsdom computes none — see the note on `isVisibleToKeyboard`), and whether a screen
 * reader treats `aria-modal` as a boundary. The last of those is a browser and AT
 * behaviour and is verified by using one.
 */

const dialogWith = (html: string) => {
  const node = document.createElement('div');
  node.innerHTML = html;
  document.body.appendChild(node);
  return node;
};

const tab = (shiftKey = false) => {
  const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, cancelable: true });
  document.dispatchEvent(event);
  return event;
};

describe('focusTrap', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('wraps forward off the last control back to the first', () => {
    const node = dialogWith('<button id="a">a</button><button id="b">b</button>');
    const trap = focusTrap(node);

    document.getElementById('b')!.focus();
    const event = tab();

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement?.id).toBe('a');
    trap.destroy();
  });

  it('wraps backward off the first control round to the last', () => {
    const node = dialogWith('<button id="a">a</button><button id="b">b</button>');
    const trap = focusTrap(node);

    document.getElementById('a')!.focus();
    const event = tab(true);

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement?.id).toBe('b');
    trap.destroy();
  });

  it('leaves an interior Tab alone', () => {
    const node = dialogWith('<button id="a">a</button><button id="b">b</button>');
    const trap = focusTrap(node);

    document.getElementById('a')!.focus();
    const event = tab();

    // Nothing to correct: the browser's own next-in-order lands inside the dialog anyway,
    // and a trap that moved focus here would be fighting it for no reason.
    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement?.id).toBe('a');
    trap.destroy();
  });

  it('pulls a Tab pressed from outside back into the dialog', () => {
    const outside = document.createElement('button');
    outside.id = 'outside';
    document.body.appendChild(outside);
    const node = dialogWith('<button id="a">a</button><button id="b">b</button>');
    const trap = focusTrap(node);

    outside.focus();
    const event = tab();

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement?.id).toBe('a');
    trap.destroy();
  });

  it('swallows Tab entirely when the dialog has nothing focusable', () => {
    const node = dialogWith('<p>Nothing here</p>');
    const trap = focusTrap(node);

    const event = tab();

    expect(event.defaultPrevented).toBe(true);
    trap.destroy();
  });

  it('skips disabled, inert and aria-hidden controls', () => {
    const node = dialogWith(
      [
        '<button id="a">a</button>',
        '<button id="off" disabled>off</button>',
        '<div inert><button id="inert">inert</button></div>',
        '<button id="hidden" aria-hidden="true">hidden</button>',
        '<button id="z">z</button>'
      ].join('')
    );
    const trap = focusTrap(node);

    document.getElementById('z')!.focus();
    tab();
    expect(document.activeElement?.id).toBe('a');

    document.getElementById('a')!.focus();
    tab(true);
    expect(document.activeElement?.id).toBe('z');
    trap.destroy();
  });

  it('ignores a container that is only programmatically focusable', () => {
    // `tabindex="-1"` is a focus *target*, not a tab stop. Wrapping onto the dialog
    // container itself would strand the player somewhere Tab immediately leaves again.
    const node = dialogWith('<div tabindex="-1" id="shell"><button id="a">a</button></div>');
    const trap = focusTrap(node);

    document.getElementById('a')!.focus();
    tab();
    expect(document.activeElement?.id).toBe('a');
    trap.destroy();
  });

  it('gives Tab to the innermost dialog only, and hands it back on close', () => {
    const outer = dialogWith('<button id="o1">o1</button><button id="o2">o2</button>');
    const outerTrap = focusTrap(outer);
    const inner = dialogWith('<button id="i1">i1</button><button id="i2">i2</button>');
    const innerTrap = focusTrap(inner);

    // While both are up, the outer trap must not act — otherwise both handlers move focus
    // for one keystroke and the last one to run wins by accident.
    document.getElementById('i2')!.focus();
    tab();
    expect(document.activeElement?.id).toBe('i1');

    innerTrap.destroy();

    document.getElementById('o2')!.focus();
    tab();
    expect(document.activeElement?.id).toBe('o1');
    outerTrap.destroy();
  });

  it('returns focus to whatever opened it', () => {
    const opener = document.createElement('button');
    opener.id = 'opener';
    document.body.appendChild(opener);
    opener.focus();

    const node = dialogWith('<button id="a">a</button>');
    const trap = focusTrap(node);
    document.getElementById('a')!.focus();

    trap.destroy();

    expect(document.activeElement?.id).toBe('opener');
  });

  it('honours an explicit return target over the opener', () => {
    const opener = document.createElement('button');
    const explicit = document.createElement('button');
    explicit.id = 'explicit';
    document.body.append(opener, explicit);
    opener.focus();

    const node = dialogWith('<button id="a">a</button>');
    const trap = focusTrap(node, { returnFocusTo: () => explicit });
    document.getElementById('a')!.focus();

    trap.destroy();

    expect(document.activeElement?.id).toBe('explicit');
  });

  it('does not steal focus back from whatever took it while closing', () => {
    const opener = document.createElement('button');
    opener.id = 'opener';
    const elsewhere = document.createElement('input');
    elsewhere.id = 'elsewhere';
    document.body.append(opener, elsewhere);
    opener.focus();

    const node = dialogWith('<button id="a">a</button>');
    const trap = focusTrap(node);

    // The player tapped a field on the screen behind on their way out.
    elsewhere.focus();
    trap.destroy();

    expect(document.activeElement?.id).toBe('elsewhere');
  });

  it('does not chase an opener that has been removed from the document', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();

    const node = dialogWith('<button id="a">a</button>');
    const trap = focusTrap(node);
    document.getElementById('a')!.focus();
    opener.remove();

    expect(() => trap.destroy()).not.toThrow();
  });

  it('goes transparent when disabled, and stops listening when destroyed', () => {
    const node = dialogWith('<button id="a">a</button><button id="b">b</button>');
    const trap = focusTrap(node, { enabled: false });

    document.getElementById('b')!.focus();
    expect(tab().defaultPrevented).toBe(false);

    trap.update({ enabled: true });
    document.getElementById('b')!.focus();
    expect(tab().defaultPrevented).toBe(true);

    const removeListener = vi.spyOn(document, 'removeEventListener');
    trap.destroy();
    expect(removeListener).toHaveBeenCalledWith('keydown', expect.any(Function), true);

    document.getElementById('b')!.focus();
    expect(tab().defaultPrevented).toBe(false);
    removeListener.mockRestore();
  });
});
