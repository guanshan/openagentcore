import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

const ignoredDirectories = new Set(['.git', 'coverage', 'dist', 'node_modules']);
const forbiddenDirectories = new Set(['common', 'helpers', 'shared', 'utils']);
const violations = [];

async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || ignoredDirectories.has(entry.name)) {
      continue;
    }

    const child = join(directory, entry.name);
    if (forbiddenDirectories.has(entry.name)) {
      violations.push(relative(process.cwd(), child));
      continue;
    }

    await visit(child);
  }
}

await visit(process.cwd());

if (violations.length > 0) {
  console.error(
    `Forbidden directories found:\n${violations.map((path) => `- ${path}`).join('\n')}`,
  );
  process.exitCode = 1;
}
