import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const DIRS_TO_SCAN = ['client', 'server', 'web/src', 'shared'];
const EXTENSIONS = ['.ts', '.svelte'];

function findFiles(dir) {
  let results = [];
  if (!fs.existsSync(dir)) return results;
  const list = fs.readdirSync(dir);
  for (const file of list) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat && stat.isDirectory()) {
      if (file === 'node_modules' || file === 'dist' || file === 'build' || file === '.git') {
        continue;
      }
      results = results.concat(findFiles(filePath));
    } else if (EXTENSIONS.some((ext) => file.endsWith(ext))) {
      results.push(filePath);
    }
  }
  return results;
}

function processImportBlock(importBlock, fileContent) {
  // Matches named imports like: import { Foo, Bar as Baz } from 'module';
  const match = importBlock.match(/^import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"];?/s);
  if (!match) return importBlock;

  const [, importsStr, modulePath] = match;
  const items = importsStr
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  // Remaining content after removing this import block
  const restOfContent = fileContent.replace(importBlock, '');

  const keptItems = [];
  for (const item of items) {
    let localName = item;
    if (localName.startsWith('type ')) {
      localName = localName.slice(5).trim();
    }
    if (localName.includes(' as ')) {
      localName = localName.split(' as ')[1].trim();
    }

    if (!localName) continue;

    // Word boundary check in the rest of the file
    const regex = new RegExp(`\\b${localName}\\b`);
    if (regex.test(restOfContent)) {
      keptItems.push(item);
    }
  }

  if (keptItems.length === 0) {
    return ''; // Entire import block is unused
  }

  if (importBlock.includes('\n')) {
    const indent = '  ';
    return `import {\n${keptItems.map((i) => `${indent}${i}`).join(',\n')}\n} from '${modulePath}';`;
  }

  return `import { ${keptItems.join(', ')} } from '${modulePath}';`;
}

function cleanFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf-8');
  const original = content;

  // Find named import statements
  const importRegex = /^import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"];?/gm;
  const matches = Array.from(content.matchAll(importRegex));

  for (const match of matches) {
    const fullImport = match[0];
    const cleaned = processImportBlock(fullImport, content);
    if (cleaned !== fullImport) {
      content = content.replace(fullImport, cleaned);
    }
  }

  // Collapse the blank lines a deleted import block left behind — but only within the
  // import region at the top of the file.
  //
  // This used to run over the whole file, which quietly rewrote content that had nothing
  // to do with imports. A template literal containing two consecutive blank lines came
  // back with one, in any file that happened to also have an unused import, and the two
  // changes arrived in the same diff looking like one edit. Prettier does not reformat
  // inside a template literal precisely because that whitespace can be significant, and
  // neither should this.
  //
  // The region runs to the last line belonging to an import statement — `import …`, or the
  // `} from '…'` tail of a multi-line one. Computed by line rather than by regex over the
  // whole file, so a blank line left by a deletion cannot extend the boundary past itself.
  const lines = content.split('\n');
  let lastImportLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*import\b/.test(lines[i]) || /^\s*\}\s*from\s+['"]/.test(lines[i])) {
      lastImportLine = i;
    }
  }

  if (lastImportLine >= 0) {
    const head = lines.slice(0, lastImportLine + 1).join('\n');
    const tail = lines.slice(lastImportLine + 1);
    // `tail.length`, not `tail.join('\n')` — a file that is nothing but imports splits to a
    // final empty element, and testing the joined string for truthiness ate the trailing
    // newline off every generated barrel.
    content = head.replace(/\n\s*\n\s*\n/g, '\n\n') + (tail.length ? '\n' + tail.join('\n') : '');
  }

  if (content !== original) {
    fs.writeFileSync(filePath, content, 'utf-8');
    const relativePath = path.relative(rootDir, filePath);
    console.log(`Cleaned unused imports in ${relativePath}`);
  }
}

function main() {
  for (const dirName of DIRS_TO_SCAN) {
    const targetDir = path.join(rootDir, dirName);
    const files = findFiles(targetDir);
    for (const file of files) {
      cleanFile(file);
    }
  }
}

main();
