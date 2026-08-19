// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { get } from 'svelte/store';

const serviceMock = vi.hoisted(() => ({
  fetchSettings: vi.fn(),
  saveSetting: vi.fn(),
  removeSetting: vi.fn(),
  clearAppSettings: vi.fn()
}));
vi.mock('../../services/settings', () => serviceMock);

import { clearAppStorage } from '../../sdk/hooks/useStorage';
import { appDrawerHintSeen, migrateAppDrawerHintForExistingSaves } from './onboarding';

describe('App Drawer first-run hint migration', () => {
  beforeEach(() => {
    clearAppStorage('settings');
    vi.clearAllMocks();
    serviceMock.fetchSettings.mockResolvedValue([]);
  });

  it('leaves the hint unseen for a character with zero settings rows (true fresh install)', async () => {
    serviceMock.fetchSettings.mockResolvedValue([]);
    await migrateAppDrawerHintForExistingSaves();
    expect(get(appDrawerHintSeen)).toBe(false);
  });

  it('marks the hint seen for a character with unrelated settings already saved', async () => {
    serviceMock.fetchSettings.mockResolvedValue([
      { app: 'settings', setting_key: 'theme', setting_value: '"dark"' }
    ]);
    await migrateAppDrawerHintForExistingSaves();
    expect(get(appDrawerHintSeen)).toBe(true);
  });

  it('does nothing once an explicit appDrawerHintSeen row already exists', async () => {
    appDrawerHintSeen.set(false);
    serviceMock.fetchSettings.mockResolvedValue([
      { app: 'settings', setting_key: 'appDrawerHintSeen', setting_value: 'false' }
    ]);
    await migrateAppDrawerHintForExistingSaves();
    expect(get(appDrawerHintSeen)).toBe(false);
  });

  it('is a no-op once already seen', async () => {
    appDrawerHintSeen.set(true);
    await migrateAppDrawerHintForExistingSaves();
    expect(serviceMock.fetchSettings).not.toHaveBeenCalled();
  });
});
