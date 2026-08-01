/**
 * Client-side phone state that more than one controller needs to agree on.
 *
 * `isPhoneOpen` used to be a module-local in `client.ts`, which meant `CallController`
 * force-opening the phone for an incoming call left the flag reading `false`: the next
 * `M` press re-opened an already-open phone, and `toggleFreelook` no-oped because it is
 * guarded on the flag.
 */

let phoneOpen = false;
let typing = false;

export const PhoneState = {
  isOpen: (): boolean => phoneOpen,

  setOpen: (open: boolean): void => {
    phoneOpen = open;
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
