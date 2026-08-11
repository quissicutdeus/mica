/**
 * Client-side phone state that more than one controller needs to agree on.
 *
 * `isPhoneOpen` used to be a module-local in `client.ts`, which meant the call system
 * force-opening the phone for an incoming call left the flag reading `false`: the next
 * `M` press re-opened an already-open phone, and `toggleFreelook` no-oped because it is
 * guarded on the flag.
 */

let phoneOpen = false;
let typing = false;
let enabled = true;

export const PhoneState = {
  isOpen: (): boolean => phoneOpen,

  /**
   * Pushed to the server on every change so `IsPhoneOpen` has something to answer from
   * (`server/lib/PhoneOpenState.ts`) — there is no way for the server to ask a client
   * synchronously, so it is told rather than queried.
   */
  setOpen: (open: boolean): void => {
    phoneOpen = open;
    TriggerServerEvent('gphone:server:shell:setOpen', open);
  },

  /**
   * Whether the phone may be opened at all, set by `SetPhoneEnabled` for a job or an
   * item that needs to confiscate it. `togglePhone` refuses to open while this is false,
   * and disabling it while open force-closes it the same way `hideFrame` does.
   */
  isEnabled: (): boolean => enabled,

  setEnabled: (value: boolean): void => {
    enabled = value;
  },

  /**
   * True while a text field in the NUI has focus, pushed over from the web on
   * `focusin`/`focusout`.
   *
   * The client cannot see DOM focus, so it has to be told. Normally
   * `SetNuiFocus(true, true)` means no key mapping can fire while the phone is open
   * anyway — but freelook turns on `SetNuiFocusKeepInput`, and then typing `M` into a
   * message would insert the character *and* toggle the phone.
   */
  isTyping: (): boolean => typing,

  setTyping: (value: boolean): void => {
    typing = value;
  }
};
