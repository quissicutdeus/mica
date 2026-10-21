# axe's visible text is DOM text nodes

MICA-404. axe-core 4.14 runs `label-content-name-mismatch` (WCAG 2.5.3) by
default: a control with `aria-label` must have a name containing its visible
text. `visibleVirtual()` builds that text by walking every child element and
keeping each **text node** that is visible on screen. It never looks at roles or
ARIA, so a text node inside `aria-hidden`, `role="presentation"`,
`role="img" aria-label` or an SVG `<text>` still counts. Measured on Chromium
103 with a button per variant: all five violate.

What does not count is anything that is no text node: CSS generated content
(`::before { content: attr(data-x) }`) and `<img alt>`. Avatar now draws its
initials that way. Chromium (103 and current) still exposes `::before` content
as `StaticText` in its own accessibility tree (CDP
`Accessibility.getFullAXTree`), so a standalone avatar reads as it did.

**Why:** a decorative glyph or label inside a named control is the recurring
shape here (avatars, badges). Hiding it from AT does nothing for this rule.

**How to apply:** for text a labelled control paints but should not have to
name, move it into generated content, or put it into the name. Trade-off: axe's
`color-contrast` also reads text nodes only, so generated text is no longer
contrast-checked. A scoped `<style>` in an `sdk/ui` component reaches add-ons
because both `vite.addon.config.ts` and the template inline every CSS asset.
