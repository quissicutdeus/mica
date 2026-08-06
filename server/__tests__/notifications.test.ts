import { describe, it, expect, vi, beforeEach } from 'vitest';

const { dbMock, handlers } = vi.hoisted(() => {
  const captured = new Map<string, Function>();
  const previous = (globalThis as any).onNet;
  (globalThis as any).onNet = (event: string, handler: Function) => {
    captured.set(event, handler);
    return typeof previous === 'function' ? previous(event, handler) : undefined;
  };

  return {
    dbMock: { query: vi.fn(), insert: vi.fn(), update: vi.fn(), scalar: vi.fn(), single: vi.fn() },
    handlers: captured
  };
});
vi.mock('../lib/Database', () => ({ Database: dbMock }));

const bridge = vi.hoisted(() => ({ current: 'CITIZEN_1' }));
vi.mock('../lib/FrameworkBridge', () => ({
  FrameworkBridge: {
    getPlayer: () => ({ citizenid: bridge.current, source: 5, setMeta: () => {} }),
    getCitizenId: () => bridge.current,
    registerUsableItem: () => {},
    getSourceByCitizenId: () => 5,
    getSourcesByCitizenId: () => new Map([['CITIZEN_1', 5]])
  }
}));

import '../services/Notifications';
import { notifications } from '../services/Notifications';
import { appEventChannel } from '../lib/appEvents';

const CITIZEN = 'CITIZEN_1';
const SRC = 5;

const call = async (action: string, data: unknown, citizenid = CITIZEN) => {
  const handler = handlers.get(`gphone:server:notifications:${action}`);
  if (!handler) throw new Error(`no handler for notifications:${action}`);

  bridge.current = citizenid;
  (globalThis as any).source = SRC;
  (globalThis as any).emitNet = vi.fn();
  await handler('cb-1', data);
  const reply = (globalThis.emitNet as any).mock.calls[0]?.[3];
  return reply;
};

describe('Notifications Service & Repository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as any).source = SRC;
  });

  it('fetches shade notifications for the authenticated owner', async () => {
    const mockRows = [
      {
        id: 1,
        citizenid: CITIZEN,
        app: 'blabber',
        kind: 'mention',
        title: 'Blabber',
        body: 'Mentioned you',
        cleared_at: null,
        created_at: '2026-08-05T00:00:00.000Z'
      }
    ];
    dbMock.query.mockResolvedValueOnce(mockRows);

    const reply = await call('getShadeNotifications', {});
    expect(reply).toEqual(mockRows);
  });

  it('fetches unread notification counts per app', async () => {
    dbMock.query.mockResolvedValueOnce([
      { app: 'blabber', unread: 2 },
      { app: 'messages', unread: 1 }
    ]);

    const reply = await call('getUnreadCounts', {});
    expect(reply).toEqual({ blabber: 2, messages: 1 });
  });

  it('marks notifications as read', async () => {
    dbMock.query.mockResolvedValueOnce([]);

    const reply = await call('markAsRead', { ids: [1, 2] });
    expect(reply).toBe(true);
    expect(dbMock.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE gphone_notifications'),
      [expect.any(String), CITIZEN, 1, 2]
    );
  });

  it('clears individual notifications', async () => {
    dbMock.query.mockResolvedValueOnce([]);

    const reply = await call('clearNotifications', { ids: [1] });
    expect(reply).toBe(true);
    expect(dbMock.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE gphone_notifications'),
      [expect.any(String), CITIZEN, 1]
    );
  });

  it('clears all notifications for an app', async () => {
    dbMock.query.mockResolvedValueOnce([]);

    const reply = await call('clearAllNotifications', { appId: 'blabber' });
    expect(reply).toBe(true);
    expect(dbMock.query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE citizenid = ? AND app = ? AND cleared_at IS NULL'),
      expect.arrayContaining([CITIZEN, 'blabber'])
    );
  });

  it('persists notification asynchronously when appEvents push is called with notify option', async () => {
    dbMock.query.mockResolvedValueOnce([]);
    (globalThis as any).emitNet = vi.fn();

    const channel = appEventChannel('blabber');
    const outcome = channel.push(
      CITIZEN,
      'mention',
      { post_id: 10 },
      { notify: { title: 'New Mention', message: '@user mentioned you in a Blab' } }
    );

    expect(outcome.delivered).toBe(true);
    expect(dbMock.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO gphone_notifications'),
      expect.arrayContaining([
        CITIZEN,
        'blabber',
        'mention',
        'New Mention',
        '@user mentioned you in a Blab'
      ])
    );
  });
});
