// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
/**
 * The Your data pane's states (MICA-168): the ones the browser mock cannot reach, which are
 * a failed load, a refused word, a partial delete and a `kept` that could not be counted.
 * The happy path and the mock's wiring are `e2e/apps/your-data.spec.ts`.
 */
import '../../../host/registerFacets';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/svelte';
import { registerMessages } from '@mica/sdk';
import type { PrivacyExport } from '@mica/shared/types';
import en from '../locales/en.json';
import de from '../locales/de.json';

registerMessages('settings', { en, de });

if (!Element.prototype.animate) {
  Element.prototype.animate = vi.fn().mockReturnValue({
    finished: Promise.resolve(),
    cancel: vi.fn(),
    finish: vi.fn()
  });
}

const api = vi.hoisted(() => ({ loadExport: vi.fn(), requestDelete: vi.fn() }));
vi.mock('../yourData', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../yourData')>()),
  loadExport: api.loadExport,
  requestDelete: api.requestDelete
}));

import YourData from './YourData.svelte';

const held: PrivacyExport = {
  generatedAt: '2026-09-28T00:00:00.000Z',
  limitChars: 1000,
  truncated: true,
  categories: [
    {
      category: 'messages_participants',
      rows: [{ id: 1 }],
      truncated: 'rows',
      withheld: []
    }
  ]
};

describe('Your data pane', () => {
  beforeEach(() => {
    api.loadExport.mockReset().mockResolvedValue(held);
    api.requestDelete.mockReset();
  });

  it('shows a truncated category with its cut-short note', async () => {
    const { findByTestId, getByText } = render(YourData);
    await findByTestId('your-data-cat-messages_participants');
    expect(getByText('Conversation memberships')).toBeTruthy();
    expect(getByText(/Cut short: showing the first 1 rows/)).toBeTruthy();
  });

  it('says it is irreversible, keeps report content and is logged, before asking for the word', async () => {
    const { findByTestId, getByText } = render(YourData);
    await findByTestId('your-data-word');
    expect(getByText(/irreversible/)).toBeTruthy();
    expect(getByText(/open report is kept/)).toBeTruthy();
    expect(getByText(/logged/)).toBeTruthy();
    expect(getByText(/Moderation records are kept.*audit log.*unpaid invoices/)).toBeTruthy();
  });

  it('offers a retry when the load fails, never "nothing held"', async () => {
    api.loadExport.mockRejectedValueOnce('boom');
    const { findByRole, queryByText } = render(YourData);
    expect((await findByRole('alert')).textContent).toMatch(/could not be loaded/);
    expect(queryByText(/holds nothing/)).toBeNull();
    await fireEvent.click(await findByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(api.loadExport).toHaveBeenCalledTimes(2));
  });

  it("shows the server's refusal and keeps the typed word", async () => {
    api.requestDelete.mockRejectedValueOnce(new Error('Wrong word'));
    const { findByTestId, getByRole } = render(YourData);
    const input = (await findByTestId('your-data-word')) as HTMLInputElement;
    await fireEvent.input(input, { target: { value: 'nope' } });
    await fireEvent.click(getByRole('button', { name: 'Delete my data' }));
    expect((await findByTestId('your-data-error')).textContent).toBe('Wrong word');
    expect(input.value).toBe('nope');
    expect(api.requestDelete).toHaveBeenCalledWith('nope');
  });

  it('shows a partial delete as partial, naming what failed', async () => {
    api.requestDelete.mockResolvedValueOnce({
      complete: false,
      removed: 5,
      kept: null,
      failed: ['messages_participants']
    });
    const { findByTestId, getByRole } = render(YourData);
    const input = await findByTestId('your-data-word');
    await fireEvent.input(input, { target: { value: 'DELETE' } });
    await fireEvent.click(getByRole('button', { name: 'Delete my data' }));
    const result = await findByTestId('your-data-result');
    expect(result.textContent).toMatch(/only partly deleted/);
    expect((await findByTestId('your-data-removed')).textContent).toMatch(/5/);
    expect((await findByTestId('your-data-kept')).textContent).toMatch(/could not be counted/);
    expect((await findByTestId('your-data-failed')).textContent).toMatch(
      /Conversation memberships/
    );
  });

  it('shows a complete delete with what was kept', async () => {
    api.requestDelete.mockResolvedValueOnce({ complete: true, removed: 28, kept: 2, failed: [] });
    const { findByTestId, getByRole, queryByTestId } = render(YourData);
    const input = await findByTestId('your-data-word');
    await fireEvent.input(input, { target: { value: 'DELETE' } });
    await fireEvent.click(getByRole('button', { name: 'Delete my data' }));
    const result = await findByTestId('your-data-result');
    expect(result.textContent).toMatch(/Your data was deleted/);
    expect((await findByTestId('your-data-kept')).textContent).toMatch(/2/);
    expect(queryByTestId('your-data-failed')).toBeNull();
  });

  it('does not refetch after a delete, and reloads only when asked', async () => {
    api.requestDelete.mockResolvedValueOnce({ complete: true, removed: 1, kept: 0, failed: [] });
    const { findByTestId, getByRole, findByRole, queryByTestId } = render(YourData);
    await fireEvent.input(await findByTestId('your-data-word'), { target: { value: 'DELETE' } });
    await fireEvent.click(getByRole('button', { name: 'Delete my data' }));
    await findByTestId('your-data-result');
    // The export is rate limited; a fetch the player did not ask for would spend it.
    expect(api.loadExport).toHaveBeenCalledTimes(1);
    expect(queryByTestId('your-data-categories')).toBeNull();
    await fireEvent.click(await findByRole('button', { name: 'Reload my data' }));
    await waitFor(() => expect(api.loadExport).toHaveBeenCalledTimes(2));
  });

  it("shows the server's own message when the export fails, not the generic line", async () => {
    api.loadExport.mockRejectedValueOnce(
      new Error('You are doing that too often. Try again in 40s.')
    );
    const { findByTestId } = render(YourData);
    expect((await findByTestId('your-data-load-error')).textContent).toMatch(/Try again in 40s/);
  });

  it('falls back to the generic line for a relay timeout on the export', async () => {
    api.loadExport.mockRejectedValueOnce(new Error('Request timed out'));
    const { findByTestId } = render(YourData);
    expect((await findByTestId('your-data-load-error')).textContent).toMatch(/could not be loaded/);
  });

  it('lists a category cut for size and never says nothing is held', async () => {
    api.loadExport.mockResolvedValueOnce({
      generatedAt: '2026-09-28T00:00:00.000Z',
      limitChars: 1000,
      truncated: true,
      categories: [{ category: 'media', rows: [], truncated: 'size', withheld: [] }]
    } satisfies PrivacyExport);
    const { findByTestId, getByText, queryByText } = render(YourData);
    expect((await findByTestId('your-data-cat-media')).textContent).toMatch(
      /Not included: export size limit/
    );
    expect(getByText('Photos and videos')).toBeTruthy();
    expect(queryByText(/holds nothing/)).toBeNull();
  });

  it('says nothing is held only for a whole, empty export', async () => {
    api.loadExport.mockResolvedValueOnce({
      generatedAt: '2026-09-28T00:00:00.000Z',
      limitChars: 1000,
      truncated: false,
      categories: []
    } satisfies PrivacyExport);
    const { findByText } = render(YourData);
    expect(await findByText(/holds nothing/)).toBeTruthy();
  });

  it('does not say nothing happened when the delete request times out', async () => {
    api.requestDelete.mockRejectedValueOnce(new Error('Request timed out'));
    const { findByTestId, getByRole, findByRole } = render(YourData);
    await fireEvent.input(await findByTestId('your-data-word'), { target: { value: 'DELETE' } });
    await fireEvent.click(getByRole('button', { name: 'Delete my data' }));
    const text = (await findByTestId('your-data-error')).textContent ?? '';
    expect(text).toMatch(/may still be finishing/);
    expect(text).not.toMatch(/try again/i);
    await fireEvent.click(await findByRole('button', { name: 'Reload my data' }));
    await waitFor(() => expect(api.loadExport).toHaveBeenCalledTimes(2));
  });

  it('softens any other failure without a message, too', async () => {
    api.requestDelete.mockRejectedValueOnce('nope');
    const { findByTestId, getByRole } = render(YourData);
    await fireEvent.input(await findByTestId('your-data-word'), { target: { value: 'DELETE' } });
    await fireEvent.click(getByRole('button', { name: 'Delete my data' }));
    expect((await findByTestId('your-data-error')).textContent).toMatch(
      /may not have been deleted/
    );
  });
});
