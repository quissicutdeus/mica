# A test click reaches a disabled button

`fireEvent.click` on a `<button disabled>` still runs its Svelte 5 `onclick` in
jsdom: Svelte delegates `click` to the root, and the synthetic event bubbles
there whatever the button's state. A browser delivers no click from a user to a
disabled control, so "tap it and assert nothing was called" fails against
correct markup (MICA-472, Places' Set waypoint).

Assert the `disabled` property instead; that is the contract. Add a guard in the
handler only if the action must also be safe against a script calling it.
