import DOMPurify from 'dompurify';
import type { Config } from 'dompurify';
import { marked } from 'marked';

const MARKDOWN_POLICY: Config = {
  ALLOWED_TAGS: [
    'p',
    'br',
    'strong',
    'em',
    'b',
    'i',
    'code',
    'pre',
    'ul',
    'ol',
    'li',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6'
  ],
  ALLOWED_ATTR: []
};

export const renderMarkdown = (text: string): string => {
  if (!text) return '';
  try {
    const html = marked.parse(text, { async: false }) as string;
    return DOMPurify.sanitize(html, MARKDOWN_POLICY) as string;
  } catch {
    return DOMPurify.sanitize(text, { ALLOWED_TAGS: [], ALLOWED_ATTR: [] }) as string;
  }
};
