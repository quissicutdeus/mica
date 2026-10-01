// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The runner's signal, as the waits below read it. */
export interface Signal {
  readonly aborted: boolean;
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Ask `probe` until it answers something other than null or undefined, for up to `timeoutMs`.
 * For what micaOS writes after an export has already returned — a persisted notification, a
 * purge's deletes — where the only honest wait is to look again.
 */
export const eventually = async <T>(
  probe: () => Promise<T | null | undefined>,
  timeoutMs: number,
  signal: Signal,
  what: string
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== null && value !== undefined) return value;
    if (signal.aborted) throw new Error(`gave up waiting for ${what}`);
    if (Date.now() >= deadline) throw new Error(`no ${what} within ${timeoutMs} ms`);
    await sleep(200);
  }
};
