import { describe, it, expect } from 'vitest';
import { renderMarkdown } from './markdown';

describe('renderMarkdown', () => {
  it('renders valid markdown elements permitted by policy', () => {
    const input = '# Heading\n\nThis is **bold** and *italic* text.\n\n- Item 1\n- Item 2';
    const result = renderMarkdown(input);

    expect(result).toContain('<h1>Heading</h1>');
    expect(result).toContain('<strong>bold</strong>');
    expect(result).toContain('<em>italic</em>');
    expect(result).toContain('<ul>');
    expect(result).toContain('<li>Item 1</li>');
  });

  it('strips script tags and inline XSS event handlers', () => {
    const xssPayload = 'Hello <script>alert("xss")</script><img src="x" onerror="alert(1)">';
    const result = renderMarkdown(xssPayload);

    expect(result).not.toContain('<script>');
    expect(result).not.toContain('alert');
    expect(result).not.toContain('<img');
    expect(result).not.toContain('onerror');
  });

  it('strips anchor (<a>) tags to prevent CEF reload/navigation griefing', () => {
    const linkMarkdown = '[Tap me](https://example.com)';
    const result = renderMarkdown(linkMarkdown);

    expect(result).not.toContain('<a');
    expect(result).not.toContain('href');
    expect(result).toContain('Tap me');
  });

  it('sanitizes output even on empty or malformed input', () => {
    expect(renderMarkdown('')).toBe('');
    const rawHtml = '<div>Unclosed <b>html</b></div>';
    const result = renderMarkdown(rawHtml);
    expect(result).not.toContain('<div');
    expect(result).toContain('<b>html</b>');
  });
});
