// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';

const transport = vi.hoisted(() => ({ fetchNui: vi.fn(), useNuiEvent: vi.fn() }));
vi.mock('../nui/fetchNui', () => ({ fetchNui: transport.fetchNui }));
vi.mock('../nui/useNuiEvent', () => ({ useNuiEvent: transport.useNuiEvent }));

import { useNuiBridge } from './useNuiBridge';

/**
 * Destructuring this hook at module scope has to be safe.
 *
 * It was not. The hook returned the imported functions directly, so
 * `const { fetchNui } = useNuiBridge()` at the top of a module captured the transport as
 * it was at import time — before any test had replaced it. Blabber's store did exactly
 * that, went on calling the real mock registry, and the failure read as wrong fixture
 * data rather than as a stale binding.
 *
 * **The captures below are at module scope on purpose**, mirroring how an app's store
 * actually uses this. Doing it inside `it()` would pass against the bug it exists to
 * catch, which is the trap the barrel-cycle test fell into.
 */
const { fetchNui: capturedEarly } = useNuiBridge();

describe('useNuiBridge', () => {
  it('forwards to the transport as it is when called, not as it was when destructured', async () => {
    transport.fetchNui.mockResolvedValue('late');

    // The binding was destructured before this value was ever set. A snapshot would have
    // frozen whatever the transport was at import time.
    await expect(capturedEarly('getThing')).resolves.toBe('late');
    expect(transport.fetchNui).toHaveBeenCalledWith('getThing', undefined, undefined);
  });

  it('passes data and options through unchanged', async () => {
    transport.fetchNui.mockResolvedValue([]);
    await capturedEarly('getThings', { id: 1 }, { defaultValue: [] });

    expect(transport.fetchNui).toHaveBeenLastCalledWith(
      'getThings',
      { id: 1 },
      {
        defaultValue: []
      }
    );
  });

  it('wraps useNuiEvent the same way', () => {
    const { useNuiEvent } = useNuiBridge();
    const handler = vi.fn();
    useNuiEvent('setCharge', handler);

    expect(transport.useNuiEvent).toHaveBeenCalledWith('setCharge', handler);
  });
});
