// @vitest-environment jsdom
/**
 * MICA-172: which facet set this file's subject resolves against. The in-process set
 * now lives in `web/src/host/`, outside the SDK, and `sdk/index.ts` no longer pulls it in
 * on a test's behalf — a package cannot import its consumer. A test file is its own entry
 * point, so it says which side it stands in for: in-process, standing in for the shell.
 */
import '../host/registerFacets';
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
