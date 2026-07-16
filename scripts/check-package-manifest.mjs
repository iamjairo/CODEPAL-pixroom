import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const packageLock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
const lockedRoot = packageLock.packages?.[''];

if (!lockedRoot) throw new Error('package-lock.json is missing its root package entry');

for (const field of ['name', 'version', 'license']) {
  if (JSON.stringify(packageJson[field]) !== JSON.stringify(lockedRoot[field])) {
    throw new Error(`package manifest mismatch for ${field}`);
  }
}

for (const field of ['bin', 'dependencies', 'devDependencies', 'engines']) {
  if (JSON.stringify(packageJson[field] ?? {}) !== JSON.stringify(lockedRoot[field] ?? {})) {
    throw new Error(`package manifest mismatch for ${field}`);
  }
}

console.log(`package manifest check: ok (${packageJson.name}@${packageJson.version})`);