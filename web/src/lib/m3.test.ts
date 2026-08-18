import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Contrast, argbFromHex, lstarFromArgb } from '@material/material-color-utilities';
import {
  DEFAULT_SEED,
  ROLE_NAMES,
  STATE_LAYER_BASES,
  STATE_TOKEN_NAMES,
  TOKEN_NAMES,
  buildSchemes,
  composite,
  cssVarBlock,
  sanitizeSeed,
  seedFromRgbString
} from './m3';

/**
 * The color engine, and the closest thing the suite has to an in-game check.
 *
 * Nothing here proves anything renders in CEF 103 — AGENTS.md §6 is explicit that only
 * `nui_devTools` can say that, and Playwright drives a modern Chromium. What these
 * tests do is close off the way a modern color function would *get* into the output:
 * every emitted value is asserted to be plain `rgb()`/`rgba()`, so a future change that
 * reaches for `oklch()` or `color-mix()` fails here rather than in somebody's game.
 */

/** Legacy comma syntax only. No `oklch`, no `color-mix`, no `lab`, no hex, no bare `var`. */
const RESOLVED_COLOR = /^rgba?\(\d{1,3}, \d{1,3}, \d{1,3}(, [01](\.\d+)?)?\)$/;

/** Opaque — three channels, no alpha. What a composited state layer must be. */
const OPAQUE_RGB = /^rgb\(\d{1,3}, \d{1,3}, \d{1,3}\)$/;

/** A spread wide enough that a hue-dependent failure cannot hide in one of them. */
const SEEDS = ['#155dfc', '#ff0090', '#00ff00', '#ffffff', '#000000', '#7f7f7f', '#ffcc00'];

describe('M3 color engine', () => {
  describe('token set', () => {
    it('declares 34 roles and 25 derived tokens after disabled/selected', () => {
      expect(ROLE_NAMES).toHaveLength(34);
      expect(STATE_TOKEN_NAMES).toHaveLength(25);
      expect(TOKEN_NAMES).toHaveLength(59);
    });

    it('names no token twice', () => {
      expect(new Set(TOKEN_NAMES).size).toBe(TOKEN_NAMES.length);
    });

    it('carries exactly two on-surface text roles', () => {
      // The rule this file exists to hold. A third tier is the thing that was
      // deliberately not invented — see the ROLE_NAMES comment.
      const onSurface = ROLE_NAMES.filter((n) => n.startsWith('on-surface'));
      expect(onSurface).toEqual(['on-surface', 'on-surface-variant']);
    });

    it('omits the roles M3 deprecated or scoped to widgets', () => {
      for (const absent of ['background', 'on-background', 'surface-variant']) {
        expect(ROLE_NAMES).not.toContain(absent);
      }
      expect(ROLE_NAMES.filter((n) => n.includes('fixed'))).toEqual([]);
    });

    it('builds both schemes for every seed', () => {
      for (const seed of SEEDS) {
        const { light, dark } = buildSchemes(seed);
        expect(Object.keys(light).sort()).toEqual([...TOKEN_NAMES].sort());
        expect(Object.keys(dark).sort()).toEqual([...TOKEN_NAMES].sort());
      }
    });

    it('makes the light scheme lighter than the dark one', () => {
      // Light is generated but not yet wired up (only `dark` reaches the UI). Without
      // this, a broken light table would sit undetected until the day it is switched on.
      for (const seed of SEEDS) {
        const { light, dark } = buildSchemes(seed);
        expect(lstar(light['surface'])).toBeGreaterThan(lstar(dark['surface']));
        expect(lstar(light['on-surface'])).toBeLessThan(lstar(dark['on-surface']));
      }
    });
  });

  describe('CEF 103 output shape', () => {
    it('emits only resolved rgb()/rgba() for every token of every seed', () => {
      for (const seed of SEEDS) {
        const { light, dark } = buildSchemes(seed);
        for (const tokens of [light, dark]) {
          for (const name of TOKEN_NAMES) {
            expect(tokens[name], `${seed} ${name}`).toMatch(RESOLVED_COLOR);
          }
        }
      }
    });

    it('never emits a color function CEF 103 cannot parse', () => {
      const block = SEEDS.map((s) => cssVarBlock(buildSchemes(s).dark)).join(' ');
      for (const banned of ['oklch', 'oklab', 'color-mix', 'lab(', 'lch(', 'hwb(', 'var(']) {
        expect(block).not.toContain(banned);
      }
    });

    it('composites state layers to a flat opaque color', () => {
      // The whole reason `sdk/` can stay at zero opacity modifiers. A state layer that
      // still carried alpha would have to be expressed as `bg-surface/8` at the call
      // site, which is exactly what CEF cannot resolve for a runtime-themed token.
      for (const seed of SEEDS) {
        const { dark } = buildSchemes(seed);
        for (const name of STATE_TOKEN_NAMES) {
          if (name === 'primary-glow') continue; // a box-shadow bloom; alpha is the point
          expect(dark[name], `${seed} ${name}`).toMatch(OPAQUE_RGB);
        }
      }
    });

    it('moves each state layer off its base color', () => {
      // A composite that silently returned the base would be invisible rather than
      // wrong, and no visual review would catch it.
      const { dark } = buildSchemes(DEFAULT_SEED);
      for (const name of STATE_TOKEN_NAMES) {
        // Neither follows the base+suffix shape this check derives its comparison
        // from — both are composited over `surface`, not over a role named by
        // stripping a suffix off their own name — and both already have a dedicated
        // "differs from surface" assertion above.
        if (
          name === 'primary-glow' ||
          name === 'disabled-content' ||
          name === 'disabled-container' ||
          name === 'focus-ring'
        )
          continue;
        const base = name.replace(/-(hover|pressed|selected)$/, '');
        expect(dark[name], name).not.toBe(dark[base]);
      }
      expect(dark['surface-hover']).not.toBe(dark['surface-pressed']);
    });

    it('bakes the usage alpha into scrim rather than leaving it to an opacity modifier', () => {
      expect(buildSchemes(DEFAULT_SEED).dark['scrim']).toBe('rgba(0, 0, 0, 0.32)');
    });

    it('composites disabled state to a flat opaque color at M3s real values', () => {
      const { dark } = buildSchemes(DEFAULT_SEED);
      expect(dark['disabled-content']).toMatch(OPAQUE_RGB);
      expect(dark['disabled-container']).toMatch(OPAQUE_RGB);
      expect(dark['disabled-content']).not.toBe(dark['surface']);
      expect(dark['disabled-container']).not.toBe(dark['surface']);
      expect(dark['disabled-content']).not.toBe(dark['disabled-container']);
    });

    it('composites a selected token for every hover/pressed base', () => {
      const { dark } = buildSchemes(DEFAULT_SEED);
      for (const [base] of STATE_LAYER_BASES) {
        const selected = dark[`${base}-selected`];
        expect(selected, `${base}-selected`).toMatch(OPAQUE_RGB);
        expect(selected, `${base}-selected differs from base`).not.toBe(dark[base]);
      }
    });

    it('aliases focus-ring to primary rather than composing a new color', () => {
      for (const seed of SEEDS) {
        const { dark } = buildSchemes(seed);
        expect(dark['focus-ring']).toBe(dark['primary']);
      }
    });
  });

  describe('composite', () => {
    it('returns the base at alpha 0 and the overlay at alpha 1', () => {
      const base = argbFromHex('#000000');
      const on = argbFromHex('#ffffff');
      expect(composite(base, on, 0)).toBe('rgb(0, 0, 0)');
      expect(composite(base, on, 1)).toBe('rgb(255, 255, 255)');
    });

    it('mixes per channel', () => {
      expect(composite(argbFromHex('#000000'), argbFromHex('#ffffff'), 0.5)).toBe(
        'rgb(128, 128, 128)'
      );
    });
  });

  describe('contrast', () => {
    it('keeps every on-role legible against its own surface', () => {
      // M3's tone assignments are chosen to guarantee this; the test is here because
      // nothing else in the suite would notice if a future edit picked a different tone.
      for (const seed of SEEDS) {
        const { light, dark } = buildSchemes(seed);
        for (const tokens of [light, dark]) {
          for (const [on, base] of [
            ['on-surface', 'surface'],
            ['on-surface-variant', 'surface'],
            ['on-primary', 'primary'],
            ['on-error', 'error'],
            ['on-primary-container', 'primary-container'],
            ['on-secondary-container', 'secondary-container']
          ]) {
            const ratio = Contrast.ratioOfTones(lstar(tokens[on]), lstar(tokens[base]));
            expect(ratio, `${seed} ${on} on ${base}`).toBeGreaterThanOrEqual(4.5);
          }
        }
      }
    });
  });

  describe('seeds', () => {
    it('accepts a six-digit hex and lowercases it', () => {
      expect(sanitizeSeed('#AABBCC')).toBe('#aabbcc');
    });

    it('falls back to the default for anything else', () => {
      for (const bad of ['', '#fff', 'red', 'rgb(1,2,3)', '#gggggg', null, undefined, 42, {}]) {
        expect(sanitizeSeed(bad)).toBe(DEFAULT_SEED);
      }
    });

    it('converts the picker rgba string, dropping the alpha', () => {
      expect(seedFromRgbString('rgba(59, 130, 246, 1)')).toBe('#3b82f6');
      expect(seedFromRgbString('rgba(59, 130, 246, 0.4)')).toBe('#3b82f6');
      expect(seedFromRgbString('rgb(0, 0, 0)')).toBe('#000000');
      expect(seedFromRgbString('not a color')).toBeNull();
    });

    it('round-trips a picked color back through sanitizeSeed', () => {
      const seed = seedFromRgbString('rgba(21, 93, 252, 1)');
      expect(seed).not.toBeNull();
      expect(sanitizeSeed(seed)).toBe(seed);
    });

    it('is deterministic', () => {
      expect(cssVarBlock(buildSchemes(DEFAULT_SEED).dark)).toBe(
        cssVarBlock(buildSchemes(DEFAULT_SEED).dark)
      );
    });

    it('gives different seeds different primaries', () => {
      expect(buildSchemes('#155dfc').dark['primary']).not.toBe(
        buildSchemes('#ff0090').dark['primary']
      );
    });

    it('does not seed the error palette from the source color', () => {
      // Error is red in every M3 scheme regardless of seed, which is why the battery
      // and bank signal colors can safely map onto it while yellow and green cannot.
      const red = buildSchemes('#00ff00').dark['error'];
      expect(red).toBe(buildSchemes('#155dfc').dark['error']);
    });
  });

  describe('golden values', () => {
    it('pins the default seed', () => {
      // Catches an MCU version bump silently changing the spec. If this fails after an
      // upgrade, check the release notes before updating the numbers — every color in
      // the phone moved.
      const { dark } = buildSchemes(DEFAULT_SEED);
      expect(dark['surface']).toBe('rgb(17, 19, 28)');
      expect(dark['primary']).toBe('rgb(182, 196, 255)');
      expect(dark['on-surface']).toBe('rgb(225, 225, 239)');
      expect(dark['outline-variant']).toBe('rgb(67, 70, 84)');
    });
  });

  describe('app.css', () => {
    it('declares exactly the generated dark scheme', () => {
      // The `@theme` block holds literals so that first paint, and every jsdom render,
      // is correct before any JS runs. Literals drift; this is what stops them.
      //
      // When this fails, the diff is the fix: paste the expected values into the
      // `@theme` block of `src/app.css`.
      const css = readFileSync(join(__dirname, '..', 'app.css'), 'utf-8');
      const declared = new Map<string, string>();
      for (const [, name, value] of css.matchAll(/^\s*--color-([a-z0-9-]+):\s*([^;]+);/gm)) {
        declared.set(name, value.trim());
      }

      const expected = buildSchemes(DEFAULT_SEED).dark;
      for (const name of TOKEN_NAMES) {
        expect(declared.get(name), `--color-${name} in app.css`).toBe(expected[name]);
      }
    });
  });
});

describe('shape scale (app.css)', () => {
  it('declares the M3 shape scale', () => {
    const css = readFileSync(join(__dirname, '..', 'app.css'), 'utf-8');
    const expected: Record<string, string> = {
      none: '0',
      xs: '4px',
      sm: '8px',
      md: '12px',
      lg: '16px',
      xl: '28px',
      full: '9999px',
      'frame-outer': '3rem',
      'frame-inner': 'calc(var(--radius-frame-outer) - 8px)'
    };
    for (const [name, value] of Object.entries(expected)) {
      const match = css.match(new RegExp(`--radius-${name}:\\s*([^;]+);`));
      expect(match, `--radius-${name} declared in app.css`).not.toBeNull();
      expect(match![1].trim(), `--radius-${name} value`).toBe(value);
    }
  });
});

describe('elevation tokens (app.css)', () => {
  it('declares the five M3 elevation shadows as plain rgba() pairs', () => {
    const css = readFileSync(join(__dirname, '..', 'app.css'), 'utf-8');
    const expected: Record<string, string> = {
      1: '0px 1px 2px 0px rgba(0, 0, 0, 0.3), 0px 1px 3px 1px rgba(0, 0, 0, 0.15)',
      2: '0px 1px 2px 0px rgba(0, 0, 0, 0.3), 0px 2px 6px 2px rgba(0, 0, 0, 0.15)',
      3: '0px 1px 3px 0px rgba(0, 0, 0, 0.3), 0px 4px 8px 3px rgba(0, 0, 0, 0.15)',
      4: '0px 2px 3px 0px rgba(0, 0, 0, 0.3), 0px 6px 10px 4px rgba(0, 0, 0, 0.15)',
      5: '0px 4px 4px 0px rgba(0, 0, 0, 0.3), 0px 8px 12px 6px rgba(0, 0, 0, 0.15)'
    };
    for (const [level, value] of Object.entries(expected)) {
      const match = css.match(new RegExp(`--shadow-elevation-${level}:\\s*([^;]+);`));
      expect(match, `--shadow-elevation-${level} declared in app.css`).not.toBeNull();
      expect(match![1].trim(), `--shadow-elevation-${level} value`).toBe(value);
    }
  });

  it('uses no color function newer than rgba()', () => {
    const css = readFileSync(join(__dirname, '..', 'app.css'), 'utf-8');
    const block = css.match(/--shadow-elevation-1:[\s\S]*?--shadow-elevation-5:[^;]+;/)![0];
    for (const banned of ['oklch', 'oklab', 'color-mix', 'lab(', 'lch(', 'hwb(']) {
      expect(block).not.toContain(banned);
    }
  });
});

describe('typography scale (app.css)', () => {
  it('declares the trimmed M3 type scale with paired line-height', () => {
    const css = readFileSync(join(__dirname, '..', 'app.css'), 'utf-8');
    const expected: Record<string, { size: string; lineHeight: string }> = {
      'title-large': { size: '22px', lineHeight: '28px' },
      'title-medium': { size: '16px', lineHeight: '24px' },
      'body-large': { size: '16px', lineHeight: '24px' },
      'body-medium': { size: '14px', lineHeight: '20px' },
      'body-small': { size: '12px', lineHeight: '16px' },
      'label-large': { size: '14px', lineHeight: '20px' },
      'label-small': { size: '11px', lineHeight: '16px' }
    };
    for (const [name, { size, lineHeight }] of Object.entries(expected)) {
      const sizeMatch = css.match(new RegExp(`--text-${name}:\\s*([^;]+);`));
      expect(sizeMatch, `--text-${name} declared`).not.toBeNull();
      expect(sizeMatch![1].trim(), `--text-${name} size`).toBe(size);

      const lineHeightMatch = css.match(new RegExp(`--text-${name}--line-height:\\s*([^;]+);`));
      expect(lineHeightMatch, `--text-${name}--line-height declared`).not.toBeNull();
      expect(lineHeightMatch![1].trim(), `--text-${name} line-height`).toBe(lineHeight);
    }
  });

  it('does not add a display-tier token', () => {
    const css = readFileSync(join(__dirname, '..', 'app.css'), 'utf-8');
    expect(css).not.toMatch(/--text-display-/);
  });
});

describe('motion tokens (app.css)', () => {
  it('declares M3 duration and easing tokens', () => {
    const css = readFileSync(join(__dirname, '..', 'app.css'), 'utf-8');
    expect(css.match(/--duration-short:\s*([^;]+);/)?.[1].trim()).toBe('100ms');
    expect(css.match(/--duration-medium:\s*([^;]+);/)?.[1].trim()).toBe('250ms');
    expect(css.match(/--duration-long:\s*([^;]+);/)?.[1].trim()).toBe('400ms');
    expect(css.match(/--ease-standard:\s*([^;]+);/)?.[1].trim()).toBe('cubic-bezier(0.2, 0, 0, 1)');
    expect(css.match(/--ease-emphasized:\s*([^;]+);/)?.[1].trim()).toBe(
      'cubic-bezier(0.05, 0.7, 0.1, 1)'
    );
  });
});

describe('icon size tokens (app.css)', () => {
  it('declares the M3 icon size scale', () => {
    const css = readFileSync(join(__dirname, '..', 'app.css'), 'utf-8');
    expect(css.match(/--size-icon-sm:\s*([^;]+);/)?.[1].trim()).toBe('1rem');
    expect(css.match(/--size-icon-md:\s*([^;]+);/)?.[1].trim()).toBe('1.25rem');
    expect(css.match(/--size-icon-lg:\s*([^;]+);/)?.[1].trim()).toBe('1.5rem');
  });
});

/** A token's L*, for contrast comparisons. */
function lstar(cssColor: string): number {
  const [r, g, b] = cssColor.match(/\d+/g)!.slice(0, 3).map(Number);
  const hex = `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
  return lstarFromArgb(argbFromHex(hex));
}
