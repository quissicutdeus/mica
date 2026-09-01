// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/svelte';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Button from './Button.svelte';

/**
 * A disabled Button has to *look* disabled, including while the pointer is on it.
 *
 * `app-utilities.css` is a hand-written flat layer sorted alphabetically, and the cascade
 * is not sorted alphabetically: `.disabled\:bg-disabled-container:disabled` and
 * `.hover\:bg-primary-container-hover:hover` are both one class plus one pseudo-class, so
 * the later of the two wins — and `hover` sorts after `disabled`. The result was a
 * disabled button that repainted itself as live under the pointer about to click it and
 * then swallowed the click, reported as MICA-99 ("Confirm stays enabled and silently
 * no-ops"). `:disabled:hover` is one class heavier and wins regardless of file order.
 *
 * This is checked as "every property a `hover:` class on this button sets is also set by
 * a `disabled:hover:` class on it" rather than as a fixed list of class names, so adding
 * a variant with a new hover colour fails here instead of shipping the same bug again.
 */
const UTILITIES = path.resolve(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
  'app-utilities.css'
);

/** `class name -> the CSS properties its rule sets`, for the flat single-selector rules. */
function propertiesByClass(): Map<string, Set<string>> {
  const css = fs.readFileSync(UTILITIES, 'utf8');
  const byClass = new Map<string, Set<string>>();

  for (const rule of css.matchAll(/(?:^|\n)(\.[^\s{}]+)[^\S\n]*\{([^{}]*)\}/g)) {
    // Trailing pseudo-classes are not part of the class name; `\:` inside an escaped
    // utility name is, which is what the lookbehind keeps.
    const name = rule[1]
      .slice(1)
      .replace(/(?<!\\):[a-z-]+/g, '')
      .replace(/\\/g, '');
    const props = [...rule[2].matchAll(/(?:^|[;{]|\n)\s*([a-z-]+)\s*:/g)].map((m) => m[1]);
    if (props.length === 0) continue;
    const set = byClass.get(name) ?? new Set<string>();
    for (const prop of props) set.add(prop);
    byClass.set(name, set);
  }

  return byClass;
}

describe('Button: a disabled button stays disabled-looking under the pointer', () => {
  const variants = ['primary', 'secondary', 'danger', 'icon'] as const;

  it.each(variants)('neutralises every hover property on a disabled %s button', (variant) => {
    const properties = propertiesByClass();
    const { container } = render(Button, { props: { variant, disabled: true } });
    const tokens = [...(container.querySelector('button')?.classList ?? [])];

    // The classes have to exist at all — a token with no rule is a silent no-op here.
    for (const token of tokens.filter((t) => t.startsWith('disabled:hover:'))) {
      expect(properties.has(token), `${token} has no rule in app-utilities.css`).toBe(true);
    }

    const neutralised = new Set(
      tokens
        .filter((t) => t.startsWith('disabled:hover:'))
        .flatMap((t) => [...(properties.get(t) ?? [])])
    );

    for (const token of tokens.filter((t) => t.startsWith('hover:'))) {
      for (const property of properties.get(token) ?? []) {
        expect(
          neutralised.has(property),
          `${variant}: ${token} sets ${property} with nothing disabled:hover: to override it`
        ).toBe(true);
      }
    }
  });

  it('still paints its variant colours when it is not disabled', () => {
    const { container } = render(Button, { props: { variant: 'primary' } });
    const tokens = [...(container.querySelector('button')?.classList ?? [])];
    expect(tokens).toContain('bg-primary-container');
    expect(tokens).toContain('hover:bg-primary-container-hover');
  });
});
