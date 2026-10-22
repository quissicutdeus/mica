// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
/**
 * MICA-176: in-process facets, as `ConversationList.test.ts` sets them up — a unit test
 * stands in for the shell.
 */
import '../../../host/registerFacets';
import { describe, it, expect } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/svelte';
import { registerMessages, type UIConversation } from '@mica/sdk';
import ConversationDetailsModal from './ConversationDetailsModal.svelte';
import en from '../locales/en.json';
import de from '../locales/de.json';

registerMessages('messages', { en, de });

const conv = {
  id: 7,
  is_group: false,
  status: 'active',
  target: '555-0101',
  targetName: 'Alex',
  lastMessage: 'hi',
  lastMessageAt: '2026-10-22T10:00:00Z',
  unreadCount: 0
} as unknown as UIConversation;

describe('ConversationDetailsModal (MICA-410)', () => {
  it('is a named modal dialog that takes focus when it opens', () => {
    render(ConversationDetailsModal, {
      props: { currentConv: conv, onclose: () => {}, ondelete: () => {} }
    });
    const dialog = screen.getByRole('dialog', { name: 'Conversation Details' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('tabindex')).toBe('-1');
    expect(document.activeElement).toBe(dialog);
    // MICA-409's title stays an h2 under the screen's h1.
    expect(screen.getByRole('heading', { level: 2, name: 'Conversation Details' })).toBeTruthy();
  });

  it('keeps Tab inside the panel rather than walking into the thread behind it', async () => {
    const outside = document.createElement('button');
    outside.textContent = 'behind';
    document.body.appendChild(outside);
    try {
      render(ConversationDetailsModal, {
        props: { currentConv: conv, onclose: () => {}, ondelete: () => {} }
      });
      const dialog = screen.getByRole('dialog');
      const buttons = [...dialog.querySelectorAll('button')];
      const last = buttons[buttons.length - 1];
      last.focus();
      await fireEvent.keyDown(last, { key: 'Tab' });
      expect(document.activeElement).toBe(buttons[0]);
      expect(document.activeElement).not.toBe(outside);
    } finally {
      outside.remove();
    }
  });
});
