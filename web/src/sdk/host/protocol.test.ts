import { describe, it, expect } from 'vitest';
import { AppPermissionError } from './protocol';
import { createInProcessHost } from './inProcess/createInProcessHost';

describe('createInProcessHost().require', () => {
  it('throws AppPermissionError with appId/permission/hookName when the permission is missing', () => {
    const host = createInProcessHost('blabber', ['contacts']);

    expect(() => host.require('camera', 'useCamera')).toThrow(AppPermissionError);
    try {
      host.require('camera', 'useCamera');
      throw new Error('expected require to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AppPermissionError);
      const permErr = err as AppPermissionError;
      expect(permErr.appId).toBe('blabber');
      expect(permErr.permission).toBe('camera');
      expect(permErr.hookName).toBe('useCamera');
    }
  });

  it('passes when the permission is declared', () => {
    const host = createInProcessHost('blabber', ['contacts']);
    expect(() => host.require('contacts', 'useContacts')).not.toThrow();
  });

  it('never throws for `null` (implicit hooks)', () => {
    const host = createInProcessHost('blabber', []);
    expect(() => host.require(null, 'useAppLevels')).not.toThrow();
  });

  it('requires every permission in array form', () => {
    const host = createInProcessHost('report_app', ['reports', 'notifications']);
    expect(() => host.require(['reports', 'notifications'], 'ReportDialog')).not.toThrow();
    expect(() => host.require(['reports', 'camera'], 'ReportDialog')).toThrow(AppPermissionError);
  });

  it('exposes appId and permissions', () => {
    const host = createInProcessHost('blabber', ['contacts', 'camera']);
    expect(host.appId).toBe('blabber');
    expect(host.permissions).toEqual(['contacts', 'camera']);
  });
});
