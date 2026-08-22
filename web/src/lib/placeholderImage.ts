/**
 * Deterministic placeholder images, generated from a seed.
 *
 * The mock data used to point at `robohash.org`, `api.dicebear.com` and
 * `images.unsplash.com`. Three problems with that, and only the first is cosmetic:
 *
 *  - It is hotlinking. Those are someone else's servers, and one of the avatar
 *    services had already stopped answering.
 *  - `pnpm dev` and the Playwright suite need the internet to look right, which makes
 *    an offline afternoon look like a broken build and gives the e2e run a flaky
 *    dependency nobody declared.
 *  - Served as a public demo, every visitor's browser makes requests to three third
 *    parties, so their IP reaches all three and the page's appearance depends on those
 *    services staying up under whatever traffic the demo gets.
 *
 * These generate an SVG from a hash of the seed instead: same seed, same image, forever,
 * with no network involved. Seed them with something stable and per-entity — a
 * `citizenid`, a `@handle`, a phone number — and a given person keeps the same face
 * across reloads, across machines, and across a database reset.
 *
 * The output is a `data:` URI, built at call time rather than baked into the bundle, so
 * what ships is this file and not sixty encoded SVGs.
 */

/** FNV-1a, 32-bit. Small, fast, and good enough to scatter similar seeds apart. */
function hash32(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * mulberry32 — a seeded PRNG.
 *
 * `Math.random()` cannot be used anywhere here: the point is that the same seed produces
 * the same image on every machine and every reload.
 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Comma-separated `hsl()` on purpose. The space-separated CSS Color 4 form is fine in
 * every browser this runs in, but these strings end up inside a `data:` URI parsed by an
 * SVG renderer rather than the CSS engine, and the older form is universally understood.
 */
const hsl = (h: number, s: number, l: number) => `hsl(${Math.round(h) % 360},${s}%,${l}%)`;

const toDataUri = (svg: string) =>
  `data:image/svg+xml,${encodeURIComponent(svg.replace(/\s+/g, ' ').trim())}`;

/**
 * A 5x5 identicon, mirrored down the middle.
 *
 * Only the left three columns are decided by the PRNG; columns 4 and 5 mirror 2 and 1.
 * Symmetry is most of what makes these read as a deliberate mark rather than noise, and
 * it is why the classic identicon shape has outlived everything that tried to replace it.
 */
export function placeholderAvatar(seed: string): string {
  const h = hash32(seed);
  const next = rng(h);
  const hue = h % 360;

  const cells: string[] = [];
  for (let x = 0; x < 3; x++) {
    for (let y = 0; y < 5; y++) {
      if (next() < 0.5) continue;
      cells.push(`<rect x="${x}" y="${y}" width="1" height="1"/>`);
      if (x < 2) cells.push(`<rect x="${4 - x}" y="${y}" width="1" height="1"/>`);
    }
  }

  // Mid-tone pair rather than a light one: an avatar is a distinct chip on both the
  // light and the dark theme, so it should not disappear into either.
  return toDataUri(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 5 5" shape-rendering="crispEdges">
       <rect width="5" height="5" fill="${hsl(hue, 52, 86)}"/>
       <g fill="${hsl(hue, 58, 42)}">${cells.join('')}</g>
     </svg>`
  );
}

/**
 * An abstract stand-in for a photograph — gallery items, message attachments, the
 * camera viewfinder in a browser.
 *
 * Deliberately not trying to look like a photo. Something that almost passes is worse
 * than something that obviously stands in: nobody files a bug about a gradient, and
 * everybody files one about a photo that will not load.
 */
export function placeholderPhoto(seed: string): string {
  const h = hash32(seed);
  const next = rng(h ^ 0x9e3779b9);
  const base = h % 360;
  const far = base + 60 + next() * 120;

  const blobs = Array.from({ length: 3 }, () => {
    const cx = Math.round(next() * 160);
    const cy = Math.round(next() * 160);
    const r = Math.round(28 + next() * 52);
    return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${hsl(base + next() * 120, 72, 62)}" opacity="0.5"/>`;
  }).join('');

  // The gradient id is scoped to its own document: each of these is a separate `data:`
  // URI in its own <img>, so a fixed id cannot collide with another one on the page.
  return toDataUri(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160">
       <defs>
         <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
           <stop offset="0" stop-color="${hsl(base, 66, 56)}"/>
           <stop offset="1" stop-color="${hsl(far, 66, 34)}"/>
         </linearGradient>
       </defs>
       <rect width="160" height="160" fill="url(#g)"/>
       ${blobs}
     </svg>`
  );
}

/** `count` distinct photos from one seed, for the fixtures that want a small gallery. */
export const placeholderPhotos = (seed: string, count: number): string[] =>
  Array.from({ length: count }, (_, i) => placeholderPhoto(`${seed}-${i}`));
