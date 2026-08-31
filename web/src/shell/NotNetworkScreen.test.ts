// @vitest-environment jsdom
/**
 * MICA-176: which facet set this file's subject resolves against. A hook no longer
 * carries its facet — `src/main.ts` picks the in-process set for the shell and `bootAddOn`
 * picks the iframe twins for an add-on — so a test file, having neither entry point, says
 * which side it is standing in for. In-process, because a unit test stands in for the shell.
 */
import '../sdk/host/inProcess/registerFacets';
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import NotNetworkScreen from './NotNetworkScreen.svelte';

describe('NotNetworkScreen component', () => {
  it('shows the app name and a no-signal message', () => {
    const { getByText } = render(NotNetworkScreen, {
      props: { title: 'Messages', onback: vi.fn() }
    });

    expect(getByText('Messages')).toBeTruthy();
    expect(getByText('No Signal')).toBeTruthy();
  });

  it('goes back through the header when tapped', async () => {
    const onback = vi.fn();
    const { getByLabelText } = render(NotNetworkScreen, {
      props: { title: 'Phone', onback }
    });

    await fireEvent.click(getByLabelText(/back/i));

    expect(onback).toHaveBeenCalledOnce();
  });
});
