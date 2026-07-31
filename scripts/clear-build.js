import fs from 'node:fs';

try {
  fs.rmSync('./dist', { recursive: true, force: true });
} catch (e) {
  console.error('Failed to clear dist folder:', e);
}
