// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { dominantColorFrom, resetDominantColorCacheForTest } from './dominantColor';

/**
 * MICA-111: the album-art tint on the now-playing card.
 *
 * Every case here is a *failure* case except the first, and that is the point. The colour
 * is a nicety; the card is not. In CEF the artwork host may be unreachable, may answer
 * without the CORS header that keeps the canvas readable, or may answer with a picture
 * that has no colour worth the name — and the card has to come out the same as it would
 * have without any of this. `null` is the answer for all of them, and nothing here
 * rejects: a rejection would reach an `$effect` that has no way to handle it.
 */

/** An `<img>` that resolves to a picture the fake canvas below will "decode". */
class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  crossOrigin: string | null = null;
  naturalWidth = 8;
  naturalHeight = 8;
  #src = '';

  set src(value: string) {
    this.#src = value;
    // A real decode is a task, not a microtask, and the module's own timeout race depends
    // on this being asynchronous.
    setTimeout(() => {
      if (value.includes('broken')) this.onerror?.();
      else this.onload?.();
    }, 0);
  }

  get src(): string {
    return this.#src;
  }
}

/** Every `crossOrigin` a load was started with, in order — the attribute is load-bearing. */
let crossOrigins: (string | null)[] = [];
let loads = 0;

/** What the fake canvas hands back, as one RGB triple repeated over the sample. */
let pixel: [number, number, number] = [220, 30, 30];
/** Set to make `getImageData` throw the way a tainted canvas does. */
let tainted = false;

const fakeCanvas = () => {
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({
      drawImage: () => {},
      getImageData: (_x: number, _y: number, w: number, h: number) => {
        if (tainted) {
          // The real thing is a DOMException named SecurityError. What matters to the
          // module is only that reading the canvas back can throw at all.
          throw new DOMException('Tainted canvases may not be exported.', 'SecurityError');
        }
        const data = new Uint8ClampedArray(w * h * 4);
        for (let i = 0; i < data.length; i += 4) {
          data[i] = pixel[0];
          data[i + 1] = pixel[1];
          data[i + 2] = pixel[2];
          data[i + 3] = 255;
        }
        return { data };
      }
    })
  };
  return canvas as unknown as HTMLCanvasElement;
};

const realImage = globalThis.Image;
const realCreate = document.createElement.bind(document);

beforeEach(() => {
  resetDominantColorCacheForTest();
  crossOrigins = [];
  loads = 0;
  pixel = [220, 30, 30];
  tainted = false;

  class Recording extends FakeImage {
    constructor() {
      super();
      loads += 1;
    }
    override set src(value: string) {
      crossOrigins.push(this.crossOrigin);
      super.src = value;
    }
    override get src(): string {
      return super.src;
    }
  }

  globalThis.Image = Recording as unknown as typeof Image;
  vi.spyOn(document, 'createElement').mockImplementation((tag: string) =>
    tag === 'canvas' ? fakeCanvas() : realCreate(tag)
  );
});

afterEach(() => {
  globalThis.Image = realImage;
  vi.restoreAllMocks();
});

describe('dominantColorFrom', () => {
  it("takes the picture's own colour as the seed", async () => {
    const seed = await dominantColorFrom('https://img.youtube.com/vi/abc/mqdefault.jpg');

    expect(seed).toMatch(/^#[0-9a-f]{6}$/);
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(seed!.slice(i, i + 2), 16));
    // A red cover has to produce a red seed. Not the exact value — the quantizer is
    // allowed to move it — but unmistakably the hue that went in, which is the whole
    // claim the feature makes.
    expect(r).toBeGreaterThan(g);
    expect(r).toBeGreaterThan(b);
  });

  /**
   * The attribute the lead proved is mandatory: without it the canvas is tainted the
   * moment a cross-origin image is drawn into it, and `getImageData` throws. It reads as
   * removable, so this is what says otherwise.
   */
  it('asks for the artwork anonymously, before the load starts', async () => {
    await dominantColorFrom('https://img.youtube.com/vi/abc/mqdefault.jpg');
    expect(crossOrigins).toEqual(['anonymous']);
  });

  it('gives up quietly when the canvas will not be read back', async () => {
    tainted = true;
    await expect(
      dominantColorFrom('https://img.youtube.com/vi/abc/mqdefault.jpg')
    ).resolves.toBeNull();
  });

  it('gives up quietly when the image never arrives', async () => {
    await expect(dominantColorFrom('https://example.invalid/broken.jpg')).resolves.toBeNull();
  });

  /**
   * A black-and-white cover has no hue to take, and taking one anyway is worse than
   * taking none: HCT's hue for a desaturated colour is arbitrary, so a flat gray scored
   * without MCU's filter comes back a confident cyan. `Score`'s own fallback (Google
   * Blue) is replaced with a sentinel for the same reason — it would be indistinguishable
   * from a genuinely blue cover.
   */
  it('returns nothing for a picture with no colour worth taking', async () => {
    pixel = [128, 128, 128];
    await expect(
      dominantColorFrom('https://img.youtube.com/vi/gray/mqdefault.jpg')
    ).resolves.toBeNull();
  });

  it('answers a repeat question from memory rather than fetching again', async () => {
    const url = 'https://img.youtube.com/vi/abc/mqdefault.jpg';
    const first = await dominantColorFrom(url);
    const second = await dominantColorFrom(url);

    expect(second).toBe(first);
    expect(loads).toBe(1);
  });

  /**
   * Failures are remembered too. If the host is unreachable in game it is unreachable for
   * the session, and the shade card is rebuilt on every pull — an uncached failure would
   * be one doomed request per pull, forever.
   */
  it('remembers a failure, and does not retry it on every shade pull', async () => {
    const url = 'https://example.invalid/broken.jpg';
    await dominantColorFrom(url);
    await dominantColorFrom(url);
    expect(loads).toBe(1);
  });

  it('shares one load between two cards asking at once', async () => {
    const url = 'https://img.youtube.com/vi/abc/mqdefault.jpg';
    const [a, b] = await Promise.all([dominantColorFrom(url), dominantColorFrom(url)]);

    expect(a).toBe(b);
    expect(loads).toBe(1);
  });
});
