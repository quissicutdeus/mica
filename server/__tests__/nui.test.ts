import { describe, it, expect } from 'vitest';
import {
  parseSetTime,
  parseSetCharge,
  parseSetSignal,
  parseNotify,
  parseOpenApp,
  parseInstallApp,
  parseUninstallApp,
  parseReceiveMail,
  parseReceiveMessage,
  parseContactShare,
  parseCallStatus
} from '@shared/nui';

describe('Shared NUI Payload Validation', () => {
  it('parses valid setTime payloads and rejects invalid ones', () => {
    expect(parseSetTime({ hours: 10, minutes: 45 })).toEqual({ hours: 10, minutes: 45 });
    expect(parseSetTime({ hour: 8, minute: 15 })).toEqual({ hours: 8, minutes: 15 });
    expect(parseSetTime({ hours: '10', minutes: 45 })).toBeNull();
    expect(parseSetTime(null)).toBeNull();
  });

  it('clamps and validates setCharge and setSignal', () => {
    expect(parseSetCharge(75)).toBe(75);
    expect(parseSetCharge(150)).toBe(100);
    expect(parseSetCharge(-20)).toBe(0);
    expect(parseSetCharge('75')).toBeNull();

    expect(parseSetSignal(4)).toBe(4);
    expect(parseSetSignal(10)).toBe(5);
    expect(parseSetSignal(null)).toBeNull();
  });

  it('validates notify toasts with defaults and length bounds', () => {
    expect(parseNotify({ type: 'error', title: 'Alert', message: 'Unauthorized' })).toEqual({
      type: 'error',
      title: 'Alert',
      message: 'Unauthorized'
    });

    expect(parseNotify({ message: 'Simple toast' })).toEqual({
      type: 'info',
      title: undefined,
      message: 'Simple toast'
    });

    expect(parseNotify({ message: '' })).toBeNull();
    expect(parseNotify({ message: 123 })).toBeNull();
  });

  it('parses app management actions', () => {
    expect(parseOpenApp({ appId: 'contacts', props: { id: 1 } })).toEqual({
      appId: 'contacts',
      props: { id: 1 }
    });
    expect(parseOpenApp({ appId: '' })).toBeNull();

    expect(parseInstallApp({ url: 'https://example.com/app.js' })).toEqual({
      url: 'https://example.com/app.js'
    });
    expect(parseUninstallApp({ appId: 'notes' })).toEqual({ appId: 'notes' });
  });

  it('parses receive mail and message payloads', () => {
    expect(parseReceiveMail({ id: 10, sender: 'boss@corp.com', subject: 'Report' })).toEqual({
      id: 10,
      citizenid: undefined,
      sender: 'boss@corp.com',
      sender_address: undefined,
      subject: 'Report',
      content: '',
      status: undefined,
      read: false,
      created_at: undefined,
      updated_at: undefined
    });

    expect(
      parseReceiveMail({
        id: 11,
        citizenid: 'ABC123',
        sender: 'boss@corp.com',
        sender_address: 'boss@corp.local',
        subject: 'Report',
        content: 'Q3 numbers are attached.',
        status: 'active',
        read: false,
        created_at: '2026-08-13T00:00:00.000Z',
        updated_at: '2026-08-13T00:00:00.000Z'
      })
    ).toEqual({
      id: 11,
      citizenid: 'ABC123',
      sender: 'boss@corp.com',
      sender_address: 'boss@corp.local',
      subject: 'Report',
      content: 'Q3 numbers are attached.',
      status: 'active',
      read: false,
      created_at: '2026-08-13T00:00:00.000Z',
      updated_at: '2026-08-13T00:00:00.000Z'
    });

    expect(
      parseReceiveMessage({
        conversation_id: 5,
        message: 'Hello',
        phone: '555-0100',
        senderName: 'Alice'
      })
    ).toEqual({
      conversationId: 5,
      message: 'Hello',
      phone: '555-0100',
      senderName: 'Alice',
      avatar: undefined,
      created_at: undefined,
      replyToId: undefined
    });

    // `deliverToParticipants` (server/services/Messages.ts) rides the full row under `row`
    // alongside the flattened display fields — `reply_to_id` only lives there.
    expect(
      parseReceiveMessage({
        conversation_id: 5,
        message: 'On my way',
        row: { id: 42, conversation_id: 5, citizenid: 'ABC', message: 'On my way', reply_to_id: 7 }
      })
    ).toMatchObject({ conversationId: 5, replyToId: 7 });
  });

  it('validates contact share payloads and trims fields', () => {
    expect(
      parseContactShare({ firstname: '  Michael  ', phone: ' 555-0100 ', lastname: ' B ' })
    ).toEqual({
      firstname: 'Michael',
      lastname: 'B',
      phone: '555-0100',
      email: undefined,
      avatar: undefined,
      favorite: false
    });

    expect(parseContactShare({ lastname: 'Smith' })).toEqual({
      firstname: undefined,
      lastname: 'Smith',
      phone: undefined,
      email: undefined,
      avatar: undefined,
      favorite: false
    });
  });

  it('validates call status payloads', () => {
    expect(parseCallStatus({ status: 'incoming', number: '555-0199', name: 'Boss' })).toEqual({
      status: 'incoming',
      number: '555-0199',
      name: 'Boss'
    });

    expect(parseCallStatus({ status: 'invalid_status', number: '123' })).toBeNull();
  });
});
