import { describe, it, expect, vi } from 'vitest';
import { renderApp } from '@gphone/sdk/testing';
import Snek from './index.svelte';

vi.mock('../../services/highscores', () => ({
  submitScore: vi.fn().mockResolvedValue(undefined),
  getLeaderboard: vi.fn().mockResolvedValue([])
}));

describe('Snek', () => {
  it('shows the title screen with a Play button for each difficulty', async () => {
    const { findByText } = renderApp(Snek, { id: 'snek' });
    expect(await findByText('Easy')).toBeTruthy();
    expect(await findByText('Medium')).toBeTruthy();
    expect(await findByText('Hard')).toBeTruthy();
  });

  it('starts a game and shows the HUD', async () => {
    const { findByText } = renderApp(Snek, { id: 'snek' });
    (await findByText('Medium')).click();
    expect(await findByText(/Score: 0/)).toBeTruthy();
  });
});
