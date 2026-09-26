// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
import '../host/registerFacets';
import { describe, it, expect, vi } from 'vitest';
import { render, waitFor } from '@testing-library/svelte';
import WidgetHost from './WidgetHost.svelte';
import Probe from './__fixtures__/WidgetProbe.svelte';
import type { WidgetEntry } from './state/widgets';

describe('WidgetHost', () => {
  it('does not reload or blank a widget when the registry hands over a new entry object', async () => {
    const load = vi.fn(() => Promise.resolve({ default: Probe }));
    const entry = (label: string): WidgetEntry => ({
      widgetId: 'w',
      label,
      sizes: ['2x1'],
      render: { kind: 'component', load }
    });
    const { container, rerender } = render(WidgetHost, {
      props: { entry: entry('A'), size: '2x1' }
    });
    await waitFor(() => expect(container.querySelector('[data-probe]')).not.toBeNull());
    await rerender({ entry: entry('B'), size: '2x1' });
    expect(container.querySelector('[data-probe]')).not.toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
  });
});
