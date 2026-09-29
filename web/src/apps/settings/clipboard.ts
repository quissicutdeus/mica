// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Copy text to the clipboard; resolves whether it worked.
 *
 * `navigator.clipboard` needs a secure context. NUI is served over
 * `https://cfx-nui-<resource>/` so it qualifies, but CEF can still refuse the
 * permission — hence the execCommand fallback, which is deprecated on the open web
 * and entirely reliable here. Shared by About (the phone number) and Your data (the
 * JSON export, MICA-168).
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const scratch = document.createElement('textarea');
      scratch.value = text;
      // Keep it off-screen and unfocusable so the phone UI does not visibly shift.
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
