import { cpSync, existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEMPLATES_DIR = fileURLToPath(new URL('../templates/', import.meta.url));
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,31}$/;
const RESERVED_ID = 'index';

/** The names `init --template` takes: the directories under `templates/`. */
export function templateNames() {
  return readdirSync(TEMPLATES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * Copies `templates/<template>` to `<parent>/<id>` and gives the copy its own id and name.
 * Returns the new directory. Throws an Error whose message says what to type instead.
 */
export function initPlugin({ id, template, name, parent }) {
  if (!ID_PATTERN.test(id) || id === RESERVED_ID) {
    throw new Error(`${id} cannot be an id: use 2 to 32 lowercase letters, digits and hyphens, starting with a letter or digit, and not "${RESERVED_ID}"`);
  }
  if (!templateNames().includes(template)) {
    throw new Error(`there is no template ${template}: choose one of ${templateNames().join(', ')}`);
  }
  if (name !== undefined && name.trim() === '') throw new Error('--name cannot be empty');
  if (name?.includes('*/')) throw new Error('a name cannot contain */, which would end the manifest comment');
  const target = resolve(parent, id);
  if (existsSync(target)) throw new Error(`${target} already exists`);

  cpSync(join(TEMPLATES_DIR, template), target, { recursive: true });
  const from = join(target, `${template}-plugin.js`);
  const to = join(target, `${id}-plugin.js`);
  if (from !== to) renameSync(from, to);

  const source = readFileSync(to, 'utf8')
    .replace(`"id": "${template}"`, () => `"id": "${id}"`)
    .replace(/"name": "[^"]*"/, () => `"name": ${JSON.stringify(name ?? id)}`);
  writeFileSync(to, source);
  return target;
}
