// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Copy text to the clipboard; resolves whether it worked.
 *
 * Settings' helper, repeated rather than imported: an add-on bundle may reach nothing outside
 * its own directory but the SDK. Inside the sandboxed frame `navigator.clipboard` is refused
 * without a `clipboard-write` grant, so the `execCommand` fallback is the path that runs —
 * from the tap's own activation. Either can still fail, which is why the code stays on screen
 * as selectable text whatever this answers.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const scratch = document.createElement('textarea');
      scratch.value = text;
      scratch.setAttribute('readonly', '');
      scratch.style.position = 'fixed';
      scratch.style.opacity = '0';
      scratch.style.pointerEvents = 'none';
      document.body.appendChild(scratch);
      scratch.select();
      const copied = document.execCommand('copy');
      document.body.removeChild(scratch);
      return copied;
    } catch {
      return false;
    }
  }
}
