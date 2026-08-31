// @vitest-environment jsdom
/**
 * MICA-172: which facet set this file's subject resolves against. The in-process set
 * now lives in `web/src/host/`, outside the SDK, and `sdk/index.ts` no longer pulls it in
 * on a test's behalf — a package cannot import its consumer. A test file is its own entry
 * point, so it says which side it stands in for: in-process, standing in for the shell.
 */
import '../../../host/registerFacets';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/svelte';

// jsdom has no Web Animations API and Svelte's `transition:fade` calls it on mount.
if (!Element.prototype.animate) {
  Element.prototype.animate = vi.fn().mockReturnValue({
    cancel: () => {},
    finish: () => {},
    startTime: 0,
    currentTime: 0,
    effect: { getComputedTiming: () => ({ duration: 0 }) }
  });
}

const bankMock = vi.hoisted(() => ({ sendMoney: vi.fn() }));
vi.mock('@gphone/sdk', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useBank: () => bankMock
}));

import SendMoneyModal from './SendMoneyModal.svelte';

describe('SendMoneyModal', () => {
  beforeEach(() => vi.clearAllMocks());

  it('Send is disabled until a phone number and a positive amount are entered', async () => {
    render(SendMoneyModal, { props: { balance: 500, onsent: () => {}, onclose: () => {} } });
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    const send = screen.getByText('Send') as HTMLButtonElement;
    expect(send.disabled).toBe(true);

    await fireEvent.input(screen.getByPlaceholderText("Recipient's phone number"), {
      target: { value: '555-0199' }
    });
    expect(send.disabled).toBe(true);

    await fireEvent.input(screen.getByPlaceholderText('Amount'), { target: { value: '50' } });
    expect(send.disabled).toBe(false);
  });

  it('sends the trimmed phone, the amount, and an optional note; reports the amount sent', async () => {
    bankMock.sendMoney.mockResolvedValue({ ok: true, to: 'CID_TARGET', amount: 50 });
    const onsent = vi.fn();
    render(SendMoneyModal, { props: { balance: 500, onsent, onclose: () => {} } });

    await fireEvent.input(screen.getByPlaceholderText("Recipient's phone number"), {
      target: { value: ' 555-0199 ' }
    });
    await fireEvent.input(screen.getByPlaceholderText('Amount'), { target: { value: '50' } });
    await fireEvent.input(screen.getByPlaceholderText('Note (optional)'), {
      target: { value: 'lunch' }
    });
    await fireEvent.click(screen.getByText('Send'));

    expect(bankMock.sendMoney).toHaveBeenCalledWith({
      phone: '555-0199',
      amount: 50,
      note: 'lunch'
    });
    expect(onsent).toHaveBeenCalledWith(50);
  });

  it('omits an empty note rather than sending an empty string', async () => {
    bankMock.sendMoney.mockResolvedValue({ ok: true, to: 'CID_TARGET', amount: 50 });
    render(SendMoneyModal, { props: { balance: 500, onsent: () => {}, onclose: () => {} } });

    await fireEvent.input(screen.getByPlaceholderText("Recipient's phone number"), {
      target: { value: '555-0199' }
    });
    await fireEvent.input(screen.getByPlaceholderText('Amount'), { target: { value: '50' } });
    await fireEvent.click(screen.getByText('Send'));

    expect(bankMock.sendMoney).toHaveBeenCalledWith(
      expect.not.objectContaining({ note: expect.anything() })
    );
  });

  it('shows the specific refusal reason rather than a generic failure', async () => {
    bankMock.sendMoney.mockResolvedValue({ ok: false, reason: 'insufficient_funds' });
    const onsent = vi.fn();
    render(SendMoneyModal, { props: { balance: 10, onsent, onclose: () => {} } });

    await fireEvent.input(screen.getByPlaceholderText("Recipient's phone number"), {
      target: { value: '555-0199' }
    });
    await fireEvent.input(screen.getByPlaceholderText('Amount'), { target: { value: '500' } });
    await fireEvent.click(screen.getByText('Send'));

    expect(await screen.findByText('Your balance is too low for this transfer.')).toBeTruthy();
    expect(onsent).not.toHaveBeenCalled();
  });

  it('shows a generic error when the request never reaches the server, without swallowing it', async () => {
    bankMock.sendMoney.mockRejectedValue(new Error('Player not authenticated'));
    render(SendMoneyModal, { props: { balance: 500, onsent: () => {}, onclose: () => {} } });

    await fireEvent.input(screen.getByPlaceholderText("Recipient's phone number"), {
      target: { value: '555-0199' }
    });
    await fireEvent.input(screen.getByPlaceholderText('Amount'), { target: { value: '50' } });
    await fireEvent.click(screen.getByText('Send'));

    expect(await screen.findByText('Player not authenticated')).toBeTruthy();
  });

  it('tapping Cancel calls onclose', async () => {
    const onclose = vi.fn();
    render(SendMoneyModal, { props: { balance: 500, onsent: () => {}, onclose } });
    await fireEvent.click(screen.getByText('Cancel'));
    expect(onclose).toHaveBeenCalled();
  });
});
