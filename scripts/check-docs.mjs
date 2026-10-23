import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const excluded = new Set(['.git', 'node_modules', 'dist', 'coverage', 'artifacts']);
const documents = [];
function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (excluded.has(entry.name) || entry.isSymbolicLink()) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.name.endsWith('.md')) documents.push(path);
  }
}
walk('.');
const errors = [];
for (const file of documents) {
  for (const match of readFileSync(file, 'utf8').matchAll(
    /\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
  )) {
    const target = match[1];
    if (/^(?:[a-z]+:|#|\/\/)/i.test(target)) continue;
    const path = decodeURIComponent(target.split('#')[0]);
    if (path && !existsSync(resolve(dirname(file), path)))
      errors.push(file + ': missing link target ' + target);
  }
}
if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else console.log('Local documentation links OK (' + documents.length + ' Markdown files).');
