import { readdirSync, readFileSync } from 'node:fs';
import { PROVIDES_SOURCE, editDistance } from './manifest.js';

const registryDir = new URL('../../../contracts/yonto-types/', import.meta.url);
const SCHEMA_SUFFIX = '.schema.json';

/** Yonto's own catalog types by name: the directory is the registry. A plugin is not one; an index lists its plugins under `plugins`. */
export const YONTO_TYPES = new Map(
  readdirSync(registryDir)
    .filter((file) => file.endsWith(SCHEMA_SUFFIX))
    .map((file) => [file.slice(0, -SCHEMA_SUFFIX.length), JSON.parse(readFileSync(new URL(file, registryDir), 'utf8'))]),
);

/** The numeric `type` of an entry that names its Yonto type in `ext.yontoType`, in either dialect. */
export const YONTO_ENTRY_TYPE = 50;

/** A 仓's numbered entries, as `YontoTypes.TVBOX_ENTRY_TYPES` has them. Its `type` 3 is a CatVod spider. */
export const TVBOX_ENTRY_TYPES = new Map([[0, 'maccms-xml'], [1, 'maccms-json']]);

/** An XPTV index's numbered entries, as `YontoTypes.XPTV_ENTRY_TYPES` has them. */
export const XPTV_ENTRY_TYPES = new Map([[1, 'maccms-json'], [3, 'xptv-js']]);

const typeName = JSON.parse(readFileSync(new URL('../../../contracts/yonto-type-name.schema.json', import.meta.url), 'utf8'));
const TYPE_NAME = new RegExp(typeName.pattern);

/** Whether [name] is a type name by `contracts/yonto-type-name.schema.json`, as `YontoTypes.isTypeName` has it. */
export function isTypeName(name) {
  return name.length <= typeName.maxLength && TYPE_NAME.test(name);
}

/**
 * Why this manifest's `handles` is refused, every reason at once; empty when it is not.
 * The names have already passed the manifest schema's grammar (contracts/yonto-type-name.schema.json).
 * [exports] is what the contract scan found the plugin exporting.
 */
export function handlesRefusals(manifest, exports) {
  const handles = manifest.handles ?? [];
  if (handles.length === 0) return [];

  const refusals = handles.flatMap((name) => nameRefusals(name, manifest.configSchema ?? []));
  if (exports.includes('getSubSources')) {
    refusals.push('a handler reads one entry as one source, and this plugin exports getSubSources');
  }
  if (manifest.catalogsAreRemote) {
    refusals.push('a handler reads one entry as one source, and this plugin declares catalogsAreRemote');
  }
  if (manifest.provides === PROVIDES_SOURCE) {
    refusals.push("a handler's address comes from its entry, so it provides 'source-type', not 'source'");
  }
  return refusals;
}

/** A name with no dot is a short id, which is Yonto's; one with dots is somebody else's reverse-DNS name. */
function nameRefusals(name, configSchema) {
  if (name.includes('.')) return [];
  const schema = YONTO_TYPES.get(name);
  if (!schema) {
    const near = [...YONTO_TYPES.keys()].find((known) => editDistance(name, known) <= 2);
    return [`${name} is a short id, which is Yonto's, and contracts/yonto-types/ has no ${name}${SCHEMA_SUFFIX}` +
      (near ? ` (did you mean ${near}?)` : '') +
      " — somebody else's type takes a reverse-DNS name (io.github.someone.alist)"];
  }
  return fieldRefusals(name, schema, configSchema);
}

/** Whether the handler's form can hold what the reader fills in for an entry of [type]. */
function fieldRefusals(type, schema, configSchema) {
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties ?? {}).flatMap(([property, spec]) => {
    const wanted = spec['x-yonto-field'];
    const field = configSchema.find((f) => f.id === property);
    if (!field) {
      return required.has(property)
        ? [`${type} requires ${property}, a ${wanted} field, and configSchema does not declare it`]
        : [];
    }
    if (wanted && field.type !== wanted) {
      return [`${type}'s ${property} is a ${wanted} field, and configSchema declares it as ${field.type}`];
    }
    if ('const' in spec && !(field.options ?? []).some((option) => option.id === spec.const)) {
      return [`${type} fills ${property} with ${spec.const}, which is not among configSchema.${property}'s options`];
    }
    return [];
  });
}
