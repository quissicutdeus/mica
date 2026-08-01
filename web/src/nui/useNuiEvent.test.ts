import { describe, it, expect, vi } from 'vitest';
import { useNuiEvent } from './useNuiEvent';

describe('useNuiEvent', () => {
  it('invokes handler when matching NUI message action is received', () => {
    const handler = vi.fn();
    const destroy = useNuiEvent<string>('testAction', handler);

    window.dispatchEvent(
      new MessageEvent('message', {
        data: { action: 'testAction', data: 'hello fivem' }
      })
    );

    expect(handler).toHaveBeenCalledWith('hello fivem');

    destroy();
  });

  it('ignores messages with non-matching actions', () => {
    const handler = vi.fn();
    const destroy = useNuiEvent('targetAction', handler);

    window.dispatchEvent(
      new MessageEvent('message', {
        data: { action: 'otherAction', data: 123 }
      })
    );

    expect(handler).not.toHaveBeenCalled();

    destroy();
  });

  it('cleans up listener when destroy is called', () => {
    const handler = vi.fn();
    const destroy = useNuiEvent('testAction', handler);

    destroy();

    window.dispatchEvent(
      new MessageEvent('message', {
        data: { action: 'testAction', data: 'after destroy' }
      })
    );

    expect(handler).not.toHaveBeenCalled();
  });
});
