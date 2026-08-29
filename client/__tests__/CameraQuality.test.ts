import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * `gphone_camera_quality` — the one knob that decides how big every stored photo is.
 *
 * Worth a test rather than a reading, because the failure is silent in the direction that
 * matters: `GetConvarInt` answers 0 for a convar it cannot parse, and 0 is a number the
 * encoder will happily accept. Nobody would notice until they opened a photo.
 *
 * Manual FiveM stubs, following `MusicProximity.test.ts`: `client/services/Camera.ts`
 * registers NUI callbacks at import time and pulls in the scripted camera, so the globals
 * have to exist before the module does.
 */
let convars: Record<string, number>;

const installGlobals = () => {
  const g = globalThis as Record<string, unknown>;
  g.GetConvarInt = (name: string, fallback: number) => convars[name] ?? fallback;
  g.RegisterNuiCallbackType = () => undefined;
  g.on = () => undefined;
  g.onNet = () => undefined;
  g.exports = new Proxy({}, { get: () => new Proxy({}, { get: () => () => undefined }) });
  g.GetActiveScreenResolution = () => [1920, 1080];
};

const load = async () => {
  vi.resetModules();
  return import('../services/Camera');
};

beforeEach(() => {
  convars = {};
  installGlobals();
});

describe('cameraQuality', () => {
  it('defaults to 95 when the convar is unset', async () => {
    const { cameraQuality } = await load();
    expect(cameraQuality()).toBe(95);
  });

  it('takes the convar when a server owner sets one', async () => {
    convars.gphone_camera_quality = 90;
    const { cameraQuality } = await load();
    expect(cameraQuality()).toBe(90);
  });

  it('refuses 0, which is what an unparseable convar reads as', async () => {
    // `set gphone_camera_quality high` is a plausible thing to type, and GetConvarInt
    // answers 0 for it. Encoding every photo at 0 would be worse than ignoring them.
    convars.gphone_camera_quality = 0;
    const { cameraQuality } = await load();
    expect(cameraQuality()).toBe(95);
  });

  it('clamps a number outside the range instead of refusing it', async () => {
    // Out of range means the owner meant something; the nearest usable value is a better
    // answer than the default they clearly did not want.
    convars.gphone_camera_quality = 250;
    expect((await load()).cameraQuality()).toBe(100);

    convars.gphone_camera_quality = -20;
    expect((await load()).cameraQuality()).toBe(95);
  });

  it('rounds a fractional value rather than passing it through', async () => {
    convars.gphone_camera_quality = 87.6;
    const { cameraQuality } = await load();
    expect(cameraQuality()).toBe(88);
  });
});
