// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
/**
 * MICA-430: the edit history a staff member opens from a report. In-process facets, standing
 * in for the shell, as every component test here does (see `SendMoneyModal.test.ts`).
 */
import '../../../host/registerFacets';
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, screen, waitFor } from '@testing-library/svelte';
import { registerMessages } from '@mica/sdk';
import type { Report } from '@mica/shared/types';
import EditHistoryDialog from './EditHistoryDialog.svelte';
import type { ReportVersion } from './labels';
import en from '../locales/en.json';
import de from '../locales/de.json';

registerMessages('admin', { en, de });

const report = { id: 1, target_table: 'mica_messages', target_id: 4 } as Report;

const version = (over: Partial<ReportVersion>): ReportVersion => ({
  id: 1,
  reason: 'edit',
  replaced_at: '2026-07-30T09:41:00Z',
  written_at: null,
  by_owner: true,
  values: [{ column: 'body', value: 'old text' }],
  ...over
});

describe('EditHistoryDialog', () => {
  it('reads the report’s versions once on open and shows them in the order given', async () => {
    const load = vi
      .fn()
      .mockResolvedValue([
        version({ id: 3, values: [{ column: 'body', value: 'newest' }] }),
        version({ id: 2, reason: 'handover', by_owner: null }),
        version({ id: 1, by_owner: false, values: [{ column: 'body', value: 'oldest' }] })
      ]);
    render(EditHistoryDialog, { props: { report, load, onclose: () => {} } });

    await waitFor(() => expect(screen.getAllByTestId('admin-version')).toHaveLength(3));
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith(1);
    const items = screen.getAllByTestId('admin-version');
    expect(items[0].textContent).toContain('newest');
    expect(items[0].textContent).toContain('Edited');
    expect(items[0].textContent).toContain('Changed by its owner');
    expect(items[1].textContent).toContain('Phone handed over');
    expect(items[1].textContent).toContain('Changed by the server or staff');
    expect(items[2].textContent).toContain('Changed by someone else');
    expect(items[2].textContent).toContain('oldest');
  });

  it('renders old text as text, never as markup', async () => {
    const load = vi
      .fn()
      .mockResolvedValue([
        version({ values: [{ column: 'body', value: '<img src=x onerror=alert(1)><b>hi</b>' }] })
      ]);
    render(EditHistoryDialog, { props: { report, load, onclose: () => {} } });

    const item = await screen.findByTestId('admin-version');
    expect(item.querySelector('img, b')).toBeNull();
    expect(item.textContent).toContain('<img src=x onerror=alert(1)><b>hi</b>');
  });

  it('says a sealed, empty or field-less version in words', async () => {
    const load = vi
      .fn()
      .mockResolvedValue([
        version({ id: 3, values: [{ column: 'body', value: '\u{1F512}' }] }),
        version({ id: 2, values: [{ column: 'body', value: null }] }),
        version({ id: 1, values: [] })
      ]);
    render(EditHistoryDialog, { props: { report, load, onclose: () => {} } });

    await screen.findAllByTestId('admin-version');
    expect(screen.getByText('(sealed — no loaded key opens it)')).toBeTruthy();
    expect(screen.getByText('(empty)')).toBeTruthy();
    expect(screen.getByText('No readable fields in this version.')).toBeTruthy();
  });

  it('shows a row that was never edited as empty', async () => {
    render(EditHistoryDialog, {
      props: { report, load: vi.fn().mockResolvedValue([]), onclose: () => {} }
    });
    expect(await screen.findByText('No earlier versions')).toBeTruthy();
  });

  it('shows a failed read as a failure, not as an empty history, and retries', async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error('Not authorised.'))
      .mockResolvedValueOnce([version({})]);
    render(EditHistoryDialog, { props: { report, load, onclose: () => {} } });

    expect(await screen.findByText('The edit history could not be loaded.')).toBeTruthy();
    expect(screen.getByText('Not authorised.')).toBeTruthy();
    expect(screen.queryByText('No earlier versions')).toBeNull();

    await fireEvent.click(screen.getByText('Try again'));
    expect(await screen.findByTestId('admin-version')).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('closes from its own button', async () => {
    const onclose = vi.fn();
    render(EditHistoryDialog, {
      props: { report, load: vi.fn().mockResolvedValue([]), onclose }
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Close edit history' }));
    expect(onclose).toHaveBeenCalledTimes(1);
  });
});
