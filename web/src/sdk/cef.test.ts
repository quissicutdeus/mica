import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * The CEF capability baseline, enforced.
 *
 * FiveM's release CEF is Chromium 103. Tailwind 4's baseline is Chromium 111. Anything
 * in that gap renders correctly in `pnpm dev`, passes Playwright — which drives a modern
 * Chromium — and is broken in game. AGENTS.md §6 has said so in prose the whole time,
 * and the prose did not stop 146 opacity modifiers landing.
 *
 * One correction to §6, from reading the built CSS rather than the docs: Tailwind emits
 * an unguarded hex fallback alongside the `@supports`-guarded `color-mix()`, so an
 * opacity modifier on a *palette* color does survive CEF 103. It is only where Tailwind
 * cannot resolve the color at build time — an arbitrary `var()`-based color — that the
 * fallback is absent and the utility breaks outright. The budget below is therefore a
 * consistency ratchet with a real but narrow correctness edge, not a bug count.
 *
 * The `:has()` and container-query rules have no such fallback and are absolute.
 *
 * Note what none of this can do: a green run here is not evidence that anything renders
 * in game. Real verification is `nui_devTools`, checking the *computed* value.
 */

const ROOT = join(__dirname, '..', '..');
const SCAN = ['src/apps', 'src/sdk', 'src/shell'];

/**
 * Utilities that take a color. The prefix list is what separates an opacity modifier
 * from a fraction: `bg-gray-800/50` is `color-mix()`, `h-2/3` is a height, and a regex
 * that only looked for `<something>/<number>` would condemn `Avatar.svelte` for a
 * perfectly ordinary two-thirds.
 */
const COLOR_PROPS =
  'bg|text|border|ring|shadow|from|via|to|divide|outline|decoration|placeholder|accent|fill|stroke|caret';

/** `bg-gray-800/50`, `hover:bg-white/10`, `shadow-blue-600/30`. */
const OPACITY_MODIFIER = new RegExp(
  String.raw`\b(?:[a-z-]+:)*(?:${COLOR_PROPS})-[a-zA-Z0-9\[\]#().,%_-]+\/\d{1,3}\b`,
  'g'
);

/**
 * `has-[...]:`, `group-has-checked:`. The trailing colon is required so the pattern
 * cannot fire on ordinary prose in a comment — which is exactly how a structural test
 * in this repo has drawn a false positive before.
 */
const HAS_VARIANT = /\b(?:group-|peer-)?has-(?:\[[^\]]*\]|[a-z-]+):/g;

/** `@container`, `@min-[400px]:`, `@max-[400px]:`. */
const CONTAINER_QUERY = /@container\b|@(?:min|max)-\[/g;

/**
 * How many opacity modifiers each file is still allowed.
 *
 * A ratchet, not an exemption list. These 146 predate the token set and are grandfathered
 * so the gate is green on day one; the numbers may only go down. Migrating a file to the
 * `@theme` tokens in `app.css` means lowering its number, and emptying it means deleting
 * the line.
 *
 * `src/sdk` is deliberately absent: the primitives were migrated first, so a scaffolded
 * app inherits a CEF-safe palette without knowing this rule exists.
 */
const GRANDFATHERED: Record<string, number> = {
  'src/apps/bank/components/CreditCard.svelte': 3,
  'src/apps/camera/index.svelte': 15,
  'src/apps/contacts/components/ContactDetails.svelte': 11,
  'src/apps/contacts/components/ContactForm.svelte': 1,
  'src/apps/contacts/components/ContactList.svelte': 3,
  'src/apps/contacts/index.svelte': 1,
  'src/apps/mail/index.svelte': 5,
  'src/apps/messages/components/ConversationDetailsModal.svelte': 7,
  'src/apps/messages/components/ConversationList.svelte': 3,
  'src/apps/messages/components/MessageBubble.svelte': 1,
  'src/apps/messages/components/MessageComposer.svelte': 9,
  'src/apps/messages/components/MessageThread.svelte': 6,
  'src/apps/messages/index.svelte': 8,
  'src/apps/notes/index.svelte': 1,
  'src/apps/phone/index.svelte': 3,
  'src/apps/photos/index.svelte': 3,
  'src/apps/settings/panes/About.svelte': 4,
  'src/apps/settings/panes/Shortcuts.svelte': 1,
  'src/apps/store/components/AppDetails.svelte': 11,
  'src/apps/store/components/CatalogList.svelte': 2,
  'src/apps/store/components/InstalledList.svelte': 2,
  'src/apps/store/index.svelte': 2,
  'src/shell/ErrorBoundary.svelte': 3,
  'src/shell/PhoneFrame.svelte': 5,
  'src/shell/Shell.svelte': 1,
  'src/shell/ToastHost.svelte': 20,
  'src/shell/VolumeHud.svelte': 5
};

const walk = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(svelte|ts)$/.test(entry) && !entry.endsWith('.test.ts')) out.push(full);
  }
  return out;
};

const FILES = SCAN.flatMap((dir) => walk(join(ROOT, dir))).map((f) => ({
  path: relative(ROOT, f).replace(/\\/g, '/'),
  text: readFileSync(f, 'utf8')
}));

const countOf = (text: string, rx: RegExp) => (text.match(rx) ?? []).length;

describe('CEF capability baseline (AGENTS.md §6)', () => {
  it('finds files to check', () => {
    // A walk that silently matched nothing would make every rule below vacuous.
    expect(FILES.length).toBeGreaterThan(50);
  });

  it('adds no new opacity modifier', () => {
    // They compile to `color-mix()`, which needs Chromium 111. Define a token with a
    // pre-resolved `rgb(... / ...)` value in `app.css` instead.
    const added = FILES.map(({ path, text }) => ({
      path,
      found: countOf(text, OPACITY_MODIFIER),
      allowed: GRANDFATHERED[path] ?? 0
    }))
      .filter(({ found, allowed }) => found > allowed)
      .map(({ path, found, allowed }) => `${path}: ${found} (allowed ${allowed})`);

    expect(added, 'use an @theme token with a pre-resolved rgb(... / ...) value').toEqual([]);
  });

  it('has a grandfather list that only goes down', () => {
    // Without this the list rots: a file migrated to tokens keeps its old budget, and
    // that budget silently becomes room for a new violation later.
    const stale = Object.entries(GRANDFATHERED)
      .map(([path, allowed]) => {
        const file = FILES.find((f) => f.path === path);
        return { path, allowed, found: file ? countOf(file.text, OPACITY_MODIFIER) : 0 };
      })
      .filter(({ found, allowed }) => found < allowed)
      .map(({ path, found, allowed }) =>
        found === 0
          ? `${path}: now clean — delete the line`
          : `${path}: down to ${found} — lower the number from ${allowed}`
      );

    expect(stale, 'the ratchet tightened; update GRANDFATHERED to match').toEqual([]);
  });

  it('uses no :has() variant', () => {
    // Chromium 105. Nothing in the tree uses one today; use Svelte state instead.
    const offenders = FILES.filter(({ text }) => HAS_VARIANT.test(text)).map((f) => f.path);
    expect(offenders, 'use Svelte state rather than :has()').toEqual([]);
  });

  it('uses no container query', () => {
    // Chromium 105. Also clean today.
    const offenders = FILES.filter(({ text }) => CONTAINER_QUERY.test(text)).map((f) => f.path);
    expect(offenders, 'use Svelte state rather than a container query').toEqual([]);
  });
});
