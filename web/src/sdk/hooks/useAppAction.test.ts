// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { useAppAction } from './useAppAction';
import { toast } from '../../shell/state/toast';

beforeEach(() => toast.clear());

describe('useAppAction', () => {
  it('reports success and resolves true', async () => {
    const { run } = useAppAction();

    expect(await run(async () => {}, { success: 'Saved' })).toBe(true);
    expect(get(toast).map((t) => [t.type, t.message])).toEqual([['success', 'Saved']]);
  });

  it('says so when the work throws, rather than nothing at all', async () => {
    // The defect this exists to prevent: Contacts' delete had no toast on either path,
    // so a write the server refused was indistinguishable from one that landed.
    const { run } = useAppAction();

    expect(
      await run(async () => {
        throw new Error('Player not authenticated');
      })
    ).toBe(false);

    expect(get(toast).map((t) => [t.type, t.message])).toEqual([
      ['error', 'Player not authenticated']
    ]);
  });

  it('never shows a success toast for work that failed', async () => {
    const { run } = useAppAction();

    await run(
      async () => {
        throw new Error('nope');
      },
      { success: 'Contact added successfully' }
    );

    expect(get(toast).some((t) => t.type === 'success')).toBe(false);
  });

  it('is busy while the work is in flight and clear afterwards, even on failure', async () => {
    const { busy, run } = useAppAction();
    expect(get(busy)).toBe(false);

    let release!: () => void;
    const pending = run(() => new Promise<void>((resolve) => (release = resolve)));
    expect(get(busy)).toBe(true);

    release();
    await pending;
    expect(get(busy)).toBe(false);

    await run(async () => {
      throw new Error('nope');
    });
    // A busy flag left stuck on would disable the form for the rest of the session.
    expect(get(busy)).toBe(false);
  });

  it('prefers an explicit error message over the thrown one', async () => {
    const { run } = useAppAction();

    await run(
      async () => {
        throw new Error('SQL constraint 1452');
      },
      { error: 'Could not delete that contact' }
    );

    expect(get(toast)[0].message).toBe('Could not delete that contact');
  });

  it('tags its toasts with the app id it was given', async () => {
    const { run } = useAppAction('contacts');

    await run(async () => {}, { success: 'Saved' });
    expect(get(toast)[0].app).toBe('contacts');

    await run(async () => {
      throw new Error('nope');
    });
    expect(get(toast)[0].app).toBe('contacts');
  });

  it('leaves toasts untagged when no app id was given', async () => {
    const { run } = useAppAction();

    await run(async () => {}, { success: 'Saved' });
    expect(get(toast)[0].app).toBeUndefined();
  });
});
