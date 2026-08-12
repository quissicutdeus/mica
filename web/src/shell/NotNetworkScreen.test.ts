// @vitest-environment jsdom
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
